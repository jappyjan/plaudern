import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import { ItemTopicEntity, TopicDocumentEntity, TopicEntity } from '@plaudern/persistence';
import {
  TOPIC_DOCUMENT_PROVIDER,
  type TopicDocumentProvider,
} from './topic-document.provider';
import {
  collectTopicDocumentSources,
  sanitizeMarkers,
  toCitation,
  usedMarkers,
} from './topic-document-context';
import type { TopicDocumentJob } from './topic-document.job';
import { pruneTopicDocumentHistory, TopicDocumentService } from './topic-document.service';

/**
 * Executes one living-document generation job: gather the topic's classified
 * items into a numbered, oldest-first source list, hand them (plus the current
 * document, so it UPDATES rather than rewrites) to the provider, then persist
 * the new version. Every source referenced by an in-range `[n]` marker becomes
 * a structural citation; out-of-range markers are stripped so a hallucinated
 * number never renders as a chip. Shared by the inline and BullMQ queues.
 */
@Injectable()
export class TopicDocumentProcessor {
  private readonly logger = new Logger(TopicDocumentProcessor.name);

  constructor(
    @Inject(TOPIC_DOCUMENT_PROVIDER)
    private readonly provider: TopicDocumentProvider,
    private readonly inbox: InboxService,
    @InjectRepository(TopicDocumentEntity)
    private readonly documents: Repository<TopicDocumentEntity>,
    @InjectRepository(TopicEntity)
    private readonly topics: Repository<TopicEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly assignments: Repository<ItemTopicEntity>,
    // Resolved lazily so we can re-enqueue a follow-up generation without a
    // construction-time dependency: TopicDocumentService → queue → this
    // processor is already a cycle, and injecting the service directly would
    // close it. See the completion-time freshness re-check below (JJ-76).
    private readonly moduleRef: ModuleRef,
  ) {}

  async process(job: TopicDocumentJob): Promise<void> {
    const doc = await this.documents.findOne({ where: { id: job.documentId } });
    if (!doc) return; // version row was pruned (topic deleted) — nothing to do.

    await this.documents.update({ id: doc.id }, { status: 'processing' });
    // Snapshot of what THIS version covers, set as soon as it's known — read by
    // the `finally` below (JJ-76/JJ-77 re-check) on BOTH the success and the
    // failure path. Null until assignments are loaded: a throw before that
    // point (e.g. the topic itself is gone) has nothing meaningful to re-check.
    let coveredItemIds: Set<string> | null = null;
    try {
      const topic = await this.topics.findOne({ where: { id: job.topicId } });
      if (!topic) throw new Error('topic no longer exists');

      const assignments = await this.assignments.find({
        where: { topicId: job.topicId, userId: job.userId },
      });
      if (assignments.length === 0) throw new Error('topic has no classified items to document');
      // Anything classified after this read isn't in the sources we hand the
      // model.
      coveredItemIds = new Set(assignments.map((a) => a.inboxItemId));

      const items = await this.loadItems(assignments.map((a) => a.inboxItemId));
      const sources = collectTopicDocumentSources(items);
      if (sources.length === 0) {
        throw new Error('no classified items with usable content to document');
      }

      const previous = await this.documents.findOne({
        where: { topicId: job.topicId, status: 'succeeded' },
        order: { version: 'DESC' },
      });

      // Attribute the external AI-provider call to this user/topic so the
      // provider adapter can audit it (JJ-42). This kind has no inbox item.
      const result = await runWithAiAudit(
        { userId: job.userId, itemId: null, kind: 'topic-document' },
        () =>
          this.provider.generate(job.userId, {
            topicName: topic.name,
            topicDescription: topic.description,
            sources: sources.map((s) => ({
              marker: s.marker,
              inboxItemId: s.inboxItemId,
              title: s.title,
              occurredAt: s.occurredAt,
              text: s.text,
              language: s.language,
            })),
            previousMarkdown: previous?.markdown ?? null,
          }),
      );

      const markdown = sanitizeMarkers(result.markdown, sources.length);
      const cited = usedMarkers(markdown, sources.length);
      const citations = sources.filter((s) => cited.has(s.marker)).map(toCitation);

      await this.documents.update(
        { id: doc.id },
        {
          status: 'succeeded',
          markdown,
          citations,
          sourceItemCount: sources.length,
          model: result.model ?? null,
          error: null,
        },
      );
      this.logger.log(
        `generated living document v${doc.version} for topic ${job.topicId} ` +
          `(${sources.length} source(s), ${citations.length} cited)`,
      );

      // JJ-73: keep the append-only history bounded now that this version
      // succeeded. Best-effort — a prune hiccup must never turn an otherwise
      // successful generation into a failed job.
      try {
        const pruned = await pruneTopicDocumentHistory(this.documents, job.topicId);
        if (pruned > 0) {
          this.logger.log(`pruned ${pruned} old document version(s) for topic ${job.topicId}`);
        }
      } catch (err) {
        this.logger.warn(
          `failed to prune document history for topic ${job.topicId}: ${(err as Error).message}`,
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`topic document generation failed for topic ${job.topicId}: ${message}`);
      await this.documents.update({ id: doc.id }, { status: 'failed', error: message });
      throw err;
    } finally {
      // JJ-76/JJ-77: the enqueue-side coalescing guard DEFERS a trigger that
      // arrives while a generation is `processing` (not just `queued`). An item
      // classified in that window is invisible to this already-started run —
      // its sources were read above, before the item existed — so without a
      // re-check that item would be silently dropped until unrelated future
      // activity. Compare the topic's assignments now against what this run
      // covered; if anything new landed mid-flight, enqueue exactly ONE
      // follow-up. `enqueueRegeneration` itself coalesces, so this can't stack,
      // and it only fires when genuinely-new work exists, so it can't loop
      // (the follow-up run finds nothing newer and stops).
      //
      // Runs in `finally` — on BOTH the success path and the failure path
      // (JJ-77) — because a throw during generation (the provider call, a
      // pruning bug, anything after sources were snapshotted) must not drop a
      // gap trigger that arrived mid-flight: a failed run still leaves the
      // newly-classified item uncovered by any queued/processing generation,
      // exactly like a successful one would. Guarded on `coveredItemIds` being
      // set (null when the failure happened before the snapshot, e.g. the
      // topic itself is gone — nothing to compare against). Best-effort — a
      // failed re-enqueue must not mask the run's own outcome (a rethrow above
      // still propagates either way).
      if (coveredItemIds) {
        try {
          const currentAssignments = await this.assignments.find({
            where: { topicId: job.topicId, userId: job.userId },
            select: { inboxItemId: true },
          });
          const hasNewWork = currentAssignments.some((a) => !coveredItemIds!.has(a.inboxItemId));
          if (hasNewWork) {
            await this.moduleRef
              .get(TopicDocumentService, { strict: false })
              .enqueueRegeneration(job.userId, job.topicId);
            this.logger.log(
              `re-enqueued topic ${job.topicId}: items were classified during generation`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `failed to re-enqueue follow-up generation for topic ${job.topicId}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /** Load each item with the extractions the source builder needs. */
  private async loadItems(ids: string[]) {
    const items = [];
    for (const id of ids) {
      const item = await this.inbox.getItemById(id);
      if (item) items.push(item);
    }
    return items;
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import { pruneTopicDocumentHistory } from './topic-document.service';

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
  ) {}

  async process(job: TopicDocumentJob): Promise<void> {
    const doc = await this.documents.findOne({ where: { id: job.documentId } });
    if (!doc) return; // version row was pruned (topic deleted) — nothing to do.

    await this.documents.update({ id: doc.id }, { status: 'processing' });
    try {
      const topic = await this.topics.findOne({ where: { id: job.topicId } });
      if (!topic) throw new Error('topic no longer exists');

      const assignments = await this.assignments.find({
        where: { topicId: job.topicId, userId: job.userId },
      });
      if (assignments.length === 0) throw new Error('topic has no classified items to document');

      const items = await this.loadItems(assignments.map((a) => a.inboxItemId));
      const sources = collectTopicDocumentSources(items);
      if (sources.length === 0) {
        throw new Error('no classified items with usable content to document');
      }

      const previous = await this.documents.findOne({
        where: { topicId: job.topicId, status: 'succeeded' },
        order: { version: 'DESC' },
      });

      const result = await this.provider.generate({
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
      });

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

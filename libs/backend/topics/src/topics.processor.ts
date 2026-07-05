import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { TopicAssignmentDto, TopicClassificationPayload } from '@plaudern/contracts';
import { ItemTopicEntity, TopicEntity } from '@plaudern/persistence';
import {
  TOPIC_CLASSIFICATION_PROVIDER,
  type TopicClassificationProvider,
} from './topics.provider';
import { buildTopicContent } from './topic-context';
import { TopicDocumentService } from './topic-document.service';
import type { TopicsJob } from './topics.job';

/**
 * Executes one topics job: rebuild the classifiable text from the item's latest
 * extractions (summary preferred, transcript otherwise), classify it against
 * the owner's active taxonomy via the provider, and persist the assignments.
 * The immutable record lands in the extraction row's JSON `content`; the same
 * assignments are projected (latest-only) into `item_topics` so "list items by
 * topic" is a cheap query. Shared by the inline and BullMQ queues.
 */
@Injectable()
export class TopicsProcessor {
  private readonly logger = new Logger(TopicsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    @Inject(TOPIC_CLASSIFICATION_PROVIDER)
    private readonly provider: TopicClassificationProvider,
    @InjectRepository(TopicEntity)
    private readonly topics: Repository<TopicEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly assignments: Repository<ItemTopicEntity>,
    // Optional so unit tests can construct the processor without the living-doc
    // stack; in the wired module it is always present and drives regeneration
    // when an item lands in a topic (JJ-12).
    @Optional()
    private readonly topicDocuments?: TopicDocumentService,
  ) {}

  async process(job: TopicsJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const content = buildTopicContent(item);
      if (!content) {
        throw new Error('nothing to classify (no succeeded summary or transcription)');
      }

      const activeTopics = await this.topics.find({
        where: { userId: item.userId, archived: false },
      });

      let assignments: TopicAssignmentDto[] = [];
      let model: string | null = null;
      // With an empty taxonomy there is nothing to tag against — succeed with
      // no assignments rather than calling the model for a guaranteed empty
      // answer.
      if (activeTopics.length > 0) {
        // Attribute the external AI-provider call to this user/item so the
        // provider adapter can audit it (JJ-42).
        const result = await runWithAiAudit(
          { userId: item.userId, itemId: item.id, kind: 'topics' },
          () =>
            this.provider.classify({
              content: content.content,
              language: content.language,
              topics: activeTopics.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description,
              })),
            }),
        );
        model = result.model ?? null;
        const nameById = new Map(activeTopics.map((t) => [t.id, t.name]));
        assignments = result.assignments
          .filter((a) => nameById.has(a.topicId))
          .map((a) => ({ topicId: a.topicId, name: nameById.get(a.topicId)!, confidence: a.confidence }));
      }

      // Refresh the latest-only projection: drop the item's prior assignments
      // and insert the new ones tied to this extraction.
      await this.assignments.manager.transaction(async (em) => {
        const repo = em.getRepository(ItemTopicEntity);
        await repo.delete({ inboxItemId: item.id });
        if (assignments.length > 0) {
          await repo.save(
            assignments.map((a) =>
              repo.create({
                extractionId: job.extractionId,
                inboxItemId: item.id,
                userId: item.userId,
                topicId: a.topicId,
                name: a.name,
                confidence: a.confidence,
              }),
            ),
          );
        }
      });

      const payload: TopicClassificationPayload = { model, assignments };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `classified inbox item ${job.inboxItemId} into ${assignments.length} topic(s)`,
      );

      // The document writes itself: an item landing in a topic triggers a
      // (debounced, coalesced) regeneration of that topic's living document
      // (JJ-12). Gated on the feature being configured. Wrapped in its own
      // try/catch so it is STRUCTURALLY never fatal to classification — the
      // read model above is already committed and must not be undone by a
      // hiccup while merely scheduling a regeneration.
      if (assignments.length > 0) {
        try {
          this.topicDocuments?.onTopicsAssigned(
            item.userId,
            assignments.map((a) => a.topicId),
          );
        } catch (err) {
          this.logger.error(
            `failed to schedule living-document regeneration for ${job.inboxItemId}: ${(err as Error).message}`,
          );
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`topic classification failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

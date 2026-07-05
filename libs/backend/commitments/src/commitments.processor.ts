import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { CommitmentExtractionPayload } from '@plaudern/contracts';
import {
  COMMITMENT_EXTRACTION_PROVIDER,
  type CommitmentExtractionProvider,
} from './commitments.provider';
import { CommitmentContextService } from './commitment-context';
import { CommitmentsPersistenceService } from './commitments-persistence.service';
import { CommitmentTaskDedupeService } from './commitment-task-dedupe.service';
import type { CommitmentExtractionJob } from './commitments.job';

/**
 * Executes one commitment-extraction job: rebuild the speaker-attributed
 * transcript from the item's latest transcription + diarization, run the LLM
 * provider, then resolve relative due dates and upsert the commitments into the
 * user-scoped `commitments` table (preserving user statuses on re-runs). The
 * parent `commitments` extraction row records provenance in `content`. Shared
 * by the inline and BullMQ queues.
 *
 * Depends on CommitmentsPersistenceService — NOT on CommitmentsService — so
 * the module graph stays acyclic: the service injects the queue, whose factory
 * injects this processor, and an edge from here back to the service would
 * deadlock Nest's module compile (mirrors how the topics processor never
 * depends on TopicsService).
 */
@Injectable()
export class CommitmentsProcessor {
  private readonly logger = new Logger(CommitmentsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: CommitmentContextService,
    private readonly persistence: CommitmentsPersistenceService,
    private readonly dedupe: CommitmentTaskDedupeService,
    @Inject(COMMITMENT_EXTRACTION_PROVIDER)
    private readonly provider: CommitmentExtractionProvider,
  ) {}

  async process(job: CommitmentExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const ctx = await this.context.build(item);
      if (!ctx) {
        throw new Error('no succeeded transcription to extract commitments from');
      }

      // Owner not anchored for this item → persist zero commitments (which reaps
      // any stale/previously mis-attributed ones) rather than guessing direction.
      const result =
        ctx.kind === 'ready'
          ? await this.provider.extract(item.userId, ctx.input)
          : { commitments: [], model: this.provider.id };
      const commitmentCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        ctx.kind === 'ready' ? ctx.input.occurredAt : undefined,
        result.commitments,
      );

      // Best-effort: collapse owed_by_me commitments that duplicate one of the
      // item's tasks (its `tasks: settled` dependency guarantees they exist by
      // now). A dedupe failure must not fail the extraction — the commitments
      // are already persisted; the only cost is a duplicate lingering.
      try {
        await this.dedupe.reconcile(item.userId, item.id);
      } catch (err) {
        this.logger.warn(
          `commitment/task dedupe failed for ${job.inboxItemId}: ${(err as Error).message}`,
        );
      }

      const payload: CommitmentExtractionPayload = {
        model: result.model ?? this.provider.id,
        commitmentCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${commitmentCount} commitment(s) from inbox item ${job.inboxItemId}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`commitment extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { DecisionExtractionPayload } from '@plaudern/contracts';
import {
  DECISION_EXTRACTION_PROVIDER,
  type DecisionExtractionProvider,
} from './decisions.provider';
import { DecisionContextService } from './decision-context';
import { DecisionsPersistenceService } from './decisions-persistence.service';
import type { DecisionExtractionJob } from './decisions.job';

/**
 * Executes one decision-extraction job (JJ-33): rebuild the speaker-attributed
 * transcript from the item's latest transcription + diarization, run the LLM
 * provider, then upsert the decisions into the user-scoped `decisions` table
 * (preserving user-owned statuses on re-runs). The parent `decisions`
 * extraction row records provenance in `content`. Shared by the inline and
 * BullMQ queues.
 *
 * Depends on DecisionsPersistenceService — NOT on DecisionsService — so the
 * module graph stays acyclic: the service injects the queue, whose factory
 * injects this processor, and an edge from here back to the service would
 * deadlock Nest's module compile (mirrors the questions processor).
 */
@Injectable()
export class DecisionsProcessor {
  private readonly logger = new Logger(DecisionsProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: DecisionContextService,
    private readonly persistence: DecisionsPersistenceService,
    @Inject(DECISION_EXTRACTION_PROVIDER)
    private readonly provider: DecisionExtractionProvider,
  ) {}

  async process(job: DecisionExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = await this.context.build(item);
      if (!input) {
        throw new Error('no succeeded transcription to extract decisions from');
      }

      const result = await runWithAiAudit(
        { userId: item.userId, itemId: item.id, kind: 'decisions' },
        () => this.provider.extract(item.userId, input),
      );
      const decisionCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        result.decisions,
      );

      const payload: DecisionExtractionPayload = {
        model: result.model ?? this.provider.id,
        decisionCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${decisionCount} decision(s) from inbox item ${job.inboxItemId}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`decision extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

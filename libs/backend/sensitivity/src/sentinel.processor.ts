import { Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { SentinelPayload } from '@plaudern/contracts';
import { SentinelContextService } from './sentinel.context';
import { SentinelClassifier } from './sentinel.classifier';
import { SentinelPersistenceService } from './sentinel-persistence.service';
import type { SentinelJob } from './sentinel.job';

/**
 * Executes one sentinel classification job (JJ-21): rebuild the transcript,
 * run the classifier (deterministic detectors + optional LLM), upsert the
 * `item_sensitivity` row, and record the detected tier + mask spans in the
 * append-only `sentinel` extraction's `content` for the web to mask with.
 *
 * Depends on SentinelPersistenceService — NOT on SentinelService — so the
 * module graph stays acyclic (mirrors the reminders processor).
 */
@Injectable()
export class SentinelProcessor {
  private readonly logger = new Logger(SentinelProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: SentinelContextService,
    private readonly classifier: SentinelClassifier,
    private readonly persistence: SentinelPersistenceService,
  ) {}

  async process(job: SentinelJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = await this.context.build(item);
      if (!input) throw new Error('no succeeded transcription or OCR text to classify');

      // Attribute the sentinel's own (optional) external LLM call to this
      // user/item so its provider adapter audits it (JJ-42/JJ-81).
      const classification = await runWithAiAudit(
        { userId: item.userId, itemId: item.id, kind: 'sensitivity' },
        () => this.classifier.classify(input),
      );
      await this.persistence.upsert(
        item.userId,
        item.id,
        job.extractionId,
        classification,
      );

      const payload: SentinelPayload = {
        detectedTier: classification.detectedTier,
        detections: classification.detections,
        spans: classification.spans,
        llmClassified: classification.llmClassified,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `classified inbox item ${job.inboxItemId} as '${classification.detectedTier}'` +
          ` (${classification.spans.length} span(s), llm=${classification.llmClassified})`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`sentinel classification failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, { status: 'failed', error: message });
      throw err;
    }
  }
}

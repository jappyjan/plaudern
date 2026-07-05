import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { ReminderExtractionPayload } from '@plaudern/contracts';
import {
  REMINDER_EXTRACTION_PROVIDER,
  type ReminderExtractionProvider,
} from './reminders.provider';
import { ReminderContextService } from './reminder-context';
import { RemindersPersistenceService } from './reminders-persistence.service';
import type { ReminderExtractionJob } from './reminders.job';

/**
 * Executes one reminder-extraction job (JJ-25): rebuild the transcript from the
 * item's latest transcription, run the LLM provider, then upsert the resolved
 * reminders into the user-scoped `reminders` table (resolving relative dates
 * against the recording time and preserving user-owned statuses on re-runs).
 * The parent `reminders` extraction row records provenance in `content`.
 *
 * Depends on RemindersPersistenceService — NOT on RemindersService — so the
 * module graph stays acyclic (mirrors the decisions processor).
 */
@Injectable()
export class RemindersProcessor {
  private readonly logger = new Logger(RemindersProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: ReminderContextService,
    private readonly persistence: RemindersPersistenceService,
    @Inject(REMINDER_EXTRACTION_PROVIDER)
    private readonly provider: ReminderExtractionProvider,
  ) {}

  async process(job: ReminderExtractionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const input = await this.context.build(item);
      if (!input) {
        throw new Error('no succeeded transcription to extract reminders from');
      }

      const result = await this.provider.extract(input);
      const occurredAt = input.occurredAt ?? toIso(item.occurredAt);
      const reminderCount = await this.persistence.persist(
        item.userId,
        item.id,
        job.extractionId,
        occurredAt,
        result.reminders,
      );

      const payload: ReminderExtractionPayload = {
        model: result.model ?? this.provider.id,
        reminderCount,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `extracted ${reminderCount} reminder(s) from inbox item ${job.inboxItemId}`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`reminder extraction failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

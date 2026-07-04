import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { SummaryPayload } from '@plaudern/contracts';
import {
  SUMMARIZATION_PROVIDER,
  type SummarizationProvider,
} from './summarization.provider';
import { SummaryContextService } from './summary-context.service';
import type { SummarizationJob } from './summarization.job';

/**
 * Executes a single summarization job: rebuild the speaker-attributed
 * transcript from the item's latest extractions, run the LLM provider, and
 * write the result back onto the append-only summary extraction row (title,
 * layout and markdown are stored as JSON in `content`). Shared by the inline
 * and BullMQ queues.
 */
@Injectable()
export class SummarizationProcessor {
  private readonly logger = new Logger(SummarizationProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly context: SummaryContextService,
    @Inject(SUMMARIZATION_PROVIDER)
    private readonly provider: SummarizationProvider,
  ) {}

  async process(job: SummarizationJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const { input } = await this.context.build(item);
      if (!input) {
        throw new Error('no succeeded transcription to summarize');
      }

      const result = await this.provider.summarize(input);
      const payload: SummaryPayload = {
        title: result.title,
        layout: result.layout,
        markdown: result.markdown,
        model: result.model ?? null,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(`summarized inbox item ${job.inboxItemId} (${result.layout})`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`summarization failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

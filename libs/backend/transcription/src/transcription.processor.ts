import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import {
  TRANSCRIPTION_PROVIDER,
  type TranscriptionProvider,
} from './transcription.provider';
import type { TranscriptionJob } from './transcription.job';

/**
 * Executes a single transcription job: stream the source blob from storage,
 * run the provider, and write the result back onto the append-only extraction
 * row (plan §5). Shared by the inline and BullMQ queues.
 */
@Injectable()
export class TranscriptionProcessor {
  private readonly logger = new Logger(TranscriptionProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    @Inject(TRANSCRIPTION_PROVIDER)
    private readonly provider: TranscriptionProvider,
  ) {}

  async process(job: TranscriptionJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const stream = await this.storage.getObjectStream(job.storageKey);
      const result = await this.provider.transcribe({
        stream,
        contentType: job.contentType,
        filename: job.filename,
        languageHint: job.languageHint,
      });
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: result.text,
        segments: result.segments,
        language: result.language,
      });
      this.logger.log(`transcribed inbox item ${job.inboxItemId}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`transcription failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import {
  TRANSCRIPTION_PROVIDER,
  type TranscriptionProvider,
} from './transcription.provider';
import type { TranscriptionJob } from './transcription.job';

/**
 * Executes a single transcription job: presign the source blob, run the
 * provider, and write the result back onto the append-only extraction row
 * (plan §5). Shared by the inline and BullMQ queues.
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
      if (job.passthrough) {
        // Text-bearing source: the note body is already text, so copy the
        // stored blob into the row and let the downstream DAG take over.
        const content = await this.readText(job.storageKey);
        await this.inbox.completeExtraction(job.extractionId, {
          status: 'succeeded',
          content,
        });
        this.logger.log(`copied text content for inbox item ${job.inboxItemId}`);
        return;
      }
      // Presign at run time (not enqueue time) so queue retries never hold an
      // expired URL. The provider downloads the URL itself.
      const audioUrl = await this.storage.createInternalPresignedGetUrl(job.storageKey);
      const result = await this.provider.transcribe(job.userId, {
        audioUrl,
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

  private async readText(storageKey: string): Promise<string> {
    const stream = await this.storage.getObjectStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

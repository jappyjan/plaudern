import { Inject, Injectable, Logger } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import { TranscriptionService } from '@plaudern/transcription';
import type { OcrExtractionPayload } from '@plaudern/contracts';
import { OCR_PROVIDER, type OcrProvider } from './ocr.provider';
import type { OcrJob } from './ocr.job';

/** Cap on the bytes we base64-inline for a vision model, to bound request size. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Executes one OCR job (JJ-30): download the document blob, hand it to the
 * vision provider as a base64 data URL, and write the recognized text onto the
 * append-only `ocr` extraction row's `content`. A failure (including a model
 * that can't do vision) is caught and recorded on the row — it never breaks the
 * pipeline. The downstream `docmeta` extractor consumes this text; the
 * recognized text is also bridged into a passthrough `transcription` row so the
 * rest of the DAG (summary, topics, entities, …) runs on documents just like on
 * typed notes.
 */
@Injectable()
export class OcrProcessor {
  private readonly logger = new Logger(OcrProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    private readonly transcription: TranscriptionService,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
  ) {}

  async process(job: OcrJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const bytes = await this.readBytes(job.storageKey);
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(
          `document is too large to OCR (${bytes.byteLength} bytes > ${MAX_IMAGE_BYTES})`,
        );
      }
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');
      const imageDataUrl = `data:${job.contentType};base64,${bytes.toString('base64')}`;
      const result = await this.provider.recognize(item.userId, {
        imageDataUrl,
        contentType: job.contentType,
        filename: job.filename,
      });

      const payload: OcrExtractionPayload = {
        model: result.model ?? this.provider.id,
        charCount: result.text.length,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: result.text,
        language: result.language,
        // Provenance JSON is not needed inline (text is the content), but we keep
        // the model/charCount available for logging/debugging via the payload.
      });
      this.logger.log(
        `OCR read ${payload.charCount} chars from inbox item ${job.inboxItemId} (${payload.model})`,
      );

      // Bridge the recognized text into the extraction DAG as a passthrough
      // transcription so summary/topics/entities/… cascade for documents. Skip
      // blank scans — an empty transcription would spawn an empty summary run.
      if (result.text.trim().length > 0) {
        await this.transcription.recordExtractedText(job.inboxItemId, {
          content: result.text,
          language: result.language,
        });
      }
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`OCR failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }

  private async readBytes(storageKey: string): Promise<Buffer> {
    const stream = await this.storage.getObjectStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

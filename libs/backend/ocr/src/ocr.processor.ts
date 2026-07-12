import { Inject, Injectable, Logger } from '@nestjs/common';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import { StorageService } from '@plaudern/storage';
import { TranscriptionService } from '@plaudern/transcription';
import type { OcrExtractionPayload } from '@plaudern/contracts';
import { OCR_PROVIDER, type OcrProvider, type OcrResult } from './ocr.provider';
import type { OcrJob } from './ocr.job';
import { PdfRasterizer } from './pdf-rasterizer';

/** Cap on the bytes we base64-inline for a single vision request, to bound size. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** Cap on the source PDF's byte size — beyond this the extraction fails gracefully. */
const MAX_PDF_BYTES = 12 * 1024 * 1024;

/** Result of recognizing one document (image scan or full multi-page PDF). */
interface RecognizedDocument {
  text: string;
  language?: string;
  model?: string;
  /** Pages rasterized + OCR'd (PDFs only); undefined for single-image scans. */
  pageCount?: number;
  /** True when a PDF exceeded the page cap and later pages were dropped. */
  truncated: boolean;
}

/**
 * Executes one OCR job (JJ-30): download the document blob, hand it to the
 * vision provider as a base64 data URL, and write the recognized text onto the
 * append-only `ocr` extraction row's `content`. A failure (including a model
 * that can't do vision) is caught and recorded on the row — it never breaks the
 * pipeline. The downstream `docmeta` extractor consumes this text; the
 * recognized text is also bridged into a passthrough `transcription` row so the
 * rest of the DAG (summary, topics, entities, …) runs on documents just like on
 * typed notes.
 *
 * PDFs are rasterized to one image per page and OCR'd page-by-page (JJ-82): each
 * page is its own vision call (each wrapped in `runWithAiAudit`), and the
 * per-page text is concatenated behind `[page N]` markers so downstream keeps
 * page references. The page count is capped defensively; an over-cap document is
 * truncated with an inline note in the text (the durable signal), never failed.
 */
@Injectable()
export class OcrProcessor {
  private readonly logger = new Logger(OcrProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
    private readonly transcription: TranscriptionService,
    @Inject(OCR_PROVIDER) private readonly provider: OcrProvider,
    private readonly rasterizer: PdfRasterizer,
  ) {}

  async process(job: OcrJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const bytes = await this.readBytes(job.storageKey);
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const recognized = this.rasterizer.isPdf(job.contentType, bytes)
        ? await this.recognizePdf(item.userId, item.id, job, bytes)
        : await this.recognizeImage(item.userId, item.id, job, bytes);

      const payload: OcrExtractionPayload = {
        model: recognized.model ?? this.provider.id,
        charCount: recognized.text.length,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: recognized.text,
        language: recognized.language,
      });
      this.logger.log(
        `OCR read ${payload.charCount} chars from inbox item ${job.inboxItemId} ` +
          `(${payload.model}${recognized.pageCount ? `, ${recognized.pageCount} pages` : ''}` +
          `${recognized.truncated ? ', truncated' : ''})`,
      );

      // Bridge the recognized text into the extraction DAG as a passthrough
      // transcription so summary/topics/entities/… cascade for documents. Skip
      // blank scans — an empty transcription would spawn an empty summary run.
      if (recognized.text.trim().length > 0) {
        await this.transcription.recordExtractedText(job.inboxItemId, {
          content: recognized.text,
          language: recognized.language,
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

  /** OCR a single scanned image: one vision call, no page markers (JJ-30 shape). */
  private async recognizeImage(
    userId: string,
    itemId: string,
    job: OcrJob,
    bytes: Buffer,
  ): Promise<RecognizedDocument> {
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `document is too large to OCR (${bytes.byteLength} bytes > ${MAX_IMAGE_BYTES})`,
      );
    }
    const dataUrl = `data:${job.contentType};base64,${bytes.toString('base64')}`;
    const result = await this.recognizeOne(userId, itemId, dataUrl, job.contentType, job.filename);
    return { text: result.text, language: result.language, model: result.model, truncated: false };
  }

  /**
   * OCR a PDF page-by-page: rasterize (capped), run one vision call per page, and
   * concatenate behind `[page N]` markers so page references survive downstream.
   * Over-cap documents are truncated with an inline note — never failed. A page
   * the rasterizer refused (oversized MediaBox → `null`) or whose PNG outgrows
   * the request cap keeps its marker with a skip note, so page numbering of the
   * remaining pages stays correct.
   */
  private async recognizePdf(
    userId: string,
    itemId: string,
    job: OcrJob,
    bytes: Buffer,
  ): Promise<RecognizedDocument> {
    if (bytes.byteLength > MAX_PDF_BYTES) {
      throw new Error(
        `PDF is too large to OCR (${bytes.byteLength} bytes > ${MAX_PDF_BYTES})`,
      );
    }
    const { pages, totalPages, truncated } = await this.rasterizer.rasterize(bytes);
    if (pages.length === 0) {
      return { text: '', pageCount: 0, truncated };
    }

    const sections: string[] = [];
    let language: string | undefined;
    let model: string | undefined;
    for (let i = 0; i < pages.length; i++) {
      const pageNumber = i + 1;
      const png = pages[i];
      if (png === null || png.byteLength > MAX_IMAGE_BYTES) {
        this.logger.warn(
          png === null
            ? `page ${pageNumber} of ${job.inboxItemId} was skipped by the rasterizer (oversized page)`
            : `page ${pageNumber} of ${job.inboxItemId} rendered too large ` +
                `(${png.byteLength} bytes) — skipping OCR for it`,
        );
        sections.push(`[page ${pageNumber}]\n[page image too large to OCR]`);
        continue;
      }
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const filename = pageFilename(job.filename, pageNumber, pages.length);
      const result = await this.recognizeOne(userId, itemId, dataUrl, 'image/png', filename);
      if (!language && result.language) language = result.language;
      if (!model && result.model) model = result.model;
      sections.push(`[page ${pageNumber}]\n${result.text.trim()}`);
    }

    let text = sections.join('\n\n');
    if (truncated) {
      text += `\n\n[truncated: OCR processed the first ${pages.length} of ${totalPages} pages]`;
    }
    return { text, language, model, pageCount: pages.length, truncated };
  }

  /** One vision call, wrapped in the AI audit so every page/image is recorded. */
  private recognizeOne(
    userId: string,
    itemId: string,
    imageDataUrl: string,
    contentType: string,
    filename?: string,
  ): Promise<OcrResult> {
    return runWithAiAudit({ userId, itemId, kind: 'ocr' }, () =>
      this.provider.recognize(userId, { imageDataUrl, contentType, filename }),
    );
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

/** A per-page filename hint for the model, e.g. `contract.pdf (page 2/5)`. */
function pageFilename(base: string | undefined, page: number, total: number): string {
  const prefix = base ? `${base} ` : '';
  return `${prefix}(page ${page}/${total})`;
}

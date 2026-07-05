import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import { hasDocumentPayload } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { OCR_EXTRACTOR_VERSION, OcrService } from './ocr.service';

/**
 * OCR as a ROOT node of the extraction DAG (JJ-30). Applies to any committed
 * source whose payload is a document image or PDF — keyed off the CONTENT TYPE
 * (not the source type) so both the `image` source and a PDF uploaded as a
 * generic `file` flow through the same pipeline (JJ-16). Its recognized text
 * feeds the `docmeta` extractor.
 *
 * A NEW LLM kind: `enabled()` gates on the vision provider being configured, so
 * the disabled gate is applied BEFORE the pipeline ever enqueues a job.
 */
@Injectable()
export class OcrExtractor implements Extractor {
  readonly kind = 'ocr' as const;
  readonly version = OCR_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [];

  constructor(
    private readonly ocr: OcrService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'ocr');
  }

  appliesTo(item: InboxItemEntity): boolean {
    return (
      item.source?.uploadStatus === 'committed' &&
      hasDocumentPayload(item.source.contentType)
    );
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    if (!item.source) return null;
    return this.ocr.enqueueOcr(item.id, {
      storageKey: item.source.storageKey,
      contentType: item.source.contentType,
      filename: item.source.originalFilename ?? undefined,
    });
  }
}

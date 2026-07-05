import { Injectable } from '@nestjs/common';
import { hasDocumentPayload } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { DOCMETA_EXTRACTOR_VERSION, DocMetaService } from './docmeta.service';

/**
 * Document-understanding as a node of the extraction DAG (JJ-30/JJ-16). Depends
 * on `ocr` succeeding (nothing to understand without the recognized text), so
 * it runs after OCR for any committed image/PDF source. A NEW LLM kind:
 * `enabled()` gates on the provider being configured, so the disabled gate is
 * applied BEFORE the pipeline enqueues.
 */
@Injectable()
export class DocMetaExtractor implements Extractor {
  readonly kind = 'docmeta' as const;
  readonly version = DOCMETA_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [{ kind: 'ocr', requires: 'succeeded' }];

  constructor(private readonly docmeta: DocMetaService) {}

  enabled(): boolean {
    return this.docmeta.enabled;
  }

  appliesTo(item: InboxItemEntity): boolean {
    return (
      item.source?.uploadStatus === 'committed' &&
      hasDocumentPayload(item.source.contentType)
    );
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.docmeta.enqueueDocMeta(item.id);
  }
}

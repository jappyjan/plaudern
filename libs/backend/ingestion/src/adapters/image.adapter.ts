import { BadRequestException, Injectable } from '@nestjs/common';
import { hasDocumentPayload, type IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Photo/scan/document capture (`sources/image`, JJ-30/JJ-16). A snapped photo of
 * paper mail, a whiteboard, a receipt, a business card, a handwritten note — or
 * an uploaded PDF — enters via the same presigned init/commit flow as audio.
 * On commit the extraction DAG runs OCR (root) then docmeta, which fans out to
 * the vault, deadline reminders, and business-card contacts.
 *
 * The payload must be an image/* or application/pdf blob; the OCR/docmeta
 * extractors additionally gate on content type, so a PDF uploaded as a generic
 * `file` also flows into this pipeline.
 */
@Injectable()
export class ImageAdapter implements SourceAdapter {
  readonly sourceType = 'image' as const;

  constructor(private readonly pipeline: ExtractionPipelineService) {}

  validateInit(req: IngestInitRequest): void {
    if (!hasDocumentPayload(req.contentType)) {
      throw new BadRequestException(
        `source 'image' expects an image/* or application/pdf content type, got '${req.contentType}'`,
      );
    }
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    await this.pipeline.processCommitted(item);
  }
}

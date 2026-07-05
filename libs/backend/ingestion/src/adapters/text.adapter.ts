import { Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Direct text notes. Stored as an immutable source payload but never uploaded
 * via presigned URL (see IngestionService.ingestText). On commit the note body
 * enters the DAG as a passthrough transcription, which cascades the same
 * summary/entities/... chain as recordings.
 */
@Injectable()
export class TextAdapter implements SourceAdapter {
  readonly sourceType = 'text' as const;

  constructor(private readonly pipeline: ExtractionPipelineService) {}

  validateInit(_req: IngestInitRequest): void {
    /* text goes through the inline text endpoint, not presigned init */
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    await this.pipeline.processCommitted(item);
  }
}

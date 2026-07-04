import { Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Direct text notes. Stored as an immutable source payload but never uploaded
 * via presigned URL (see IngestionService.ingestText). The extraction DAG is
 * still consulted on commit — today no extractor applies to text/plain, but a
 * future one (e.g. text summarization) only has to declare itself.
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

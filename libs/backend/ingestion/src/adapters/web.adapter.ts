import { BadRequestException, Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Web clips (`sources/web`, VISION §2): a shared URL plus a readable-mode
 * text snapshot stored as the immutable source payload. Clips arrive through
 * the inline `POST /ingest/web` endpoint (IngestionService.ingestWeb) — the
 * snapshot is resolved server-side at ingest time, because the source blob is
 * immutable and must already contain the link-rot insurance.
 */
@Injectable()
export class WebAdapter implements SourceAdapter {
  readonly sourceType = 'web' as const;

  constructor(private readonly pipeline: ExtractionPipelineService) {}

  validateInit(_req: IngestInitRequest): void {
    throw new BadRequestException(
      "web clips use POST /ingest/web, not the presigned init/commit flow",
    );
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    // The snapshot text enters the DAG as a passthrough transcription, so web
    // clips get the same summary/entities/... cascade as every other source.
    await this.pipeline.processCommitted(item);
  }
}

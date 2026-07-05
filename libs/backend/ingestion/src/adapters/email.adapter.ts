import { BadRequestException, Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractionPipelineService } from '@plaudern/extraction';
import type { SourceAdapter } from '../source-adapter';

/**
 * Email-in (plan §2, `sources/email`). Items only ever arrive through the
 * inbound webhook (`@plaudern/email-ingest`), which builds the envelope via
 * `IngestionService.ingestBlob` directly — never through the presigned
 * `init`/`commit` flow a client drives itself. `validateInit` therefore always
 * rejects: the only reason it would run is a client mistakenly (or
 * maliciously) calling `POST /ingest/init` with `sourceType: 'email'`.
 *
 * The subject/body payload enters the DAG as a passthrough transcription;
 * attachments are stored as opaque blobs referenced from
 * `metadata.attachments`. Future work (plan §1) can OCR/transcribe those.
 */
@Injectable()
export class EmailAdapter implements SourceAdapter {
  readonly sourceType = 'email' as const;

  constructor(private readonly pipeline: ExtractionPipelineService) {}

  validateInit(_req: IngestInitRequest): void {
    throw new BadRequestException(
      "source 'email' is only created by the inbound email webhook, not by /ingest/init",
    );
  }

  async onCommitted(item: InboxItemEntity): Promise<void> {
    await this.pipeline.processCommitted(item);
  }
}

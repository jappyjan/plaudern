import { BadRequestException, Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
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

  validateInit(_req: IngestInitRequest): void {
    throw new BadRequestException(
      "web clips use POST /ingest/web, not the presigned init/commit flow",
    );
  }

  async onCommitted(_item: InboxItemEntity): Promise<void> {
    /* no derived extraction for web clips yet (future: summary/embedding) */
  }
}

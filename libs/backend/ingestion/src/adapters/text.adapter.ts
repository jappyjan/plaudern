import { Injectable } from '@nestjs/common';
import type { IngestInitRequest } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';
import type { SourceAdapter } from '../source-adapter';

/**
 * Direct text notes. Stored as an immutable source payload but never uploaded
 * via presigned URL (see IngestionService.ingestText) and not transcribed.
 */
@Injectable()
export class TextAdapter implements SourceAdapter {
  readonly sourceType = 'text' as const;

  validateInit(_req: IngestInitRequest): void {
    /* text goes through the inline text endpoint, not presigned init */
  }

  async onCommitted(_item: InboxItemEntity): Promise<void> {
    /* no derived extraction for plain text in M1 */
  }
}

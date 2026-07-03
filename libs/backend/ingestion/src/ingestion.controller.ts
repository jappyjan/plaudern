import { Body, Controller, Param, Post } from '@nestjs/common';
import {
  ingestInitRequestSchema,
  ingestTextRequestSchema,
  type IngestInitResponse,
  type IngestTextRequest,
  type InboxItemDto,
} from '@plaudern/contracts';
import { IngestionService } from './ingestion.service';

/**
 * Generic ingestion endpoints. `init`/`commit` drive the presigned upload for
 * any blob source (audio/file/plaud); `text` is the inline path. The concrete
 * behaviour per source lives in the adapters (plan §2).
 */
@Controller({ path: 'ingest', version: '1' })
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('init')
  async init(@Body() body: unknown): Promise<IngestInitResponse> {
    const req = ingestInitRequestSchema.parse(body);
    return this.ingestion.init(req);
  }

  @Post(':id/commit')
  async commit(@Param('id') id: string): Promise<InboxItemDto> {
    return this.ingestion.commit(id);
  }

  @Post(':id/reprocess')
  async reprocess(@Param('id') id: string): Promise<InboxItemDto> {
    return this.ingestion.reprocess(id);
  }

  @Post('text')
  async text(@Body() body: unknown): Promise<InboxItemDto> {
    const req: IngestTextRequest = ingestTextRequestSchema.parse(body);
    return this.ingestion.ingestText(req);
  }
}

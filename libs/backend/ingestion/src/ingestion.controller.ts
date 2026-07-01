import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import {
  ingestInitRequestSchema,
  ingestTextRequestSchema,
  type IngestInitResponse,
  type IngestTextRequest,
  type InboxItemDto,
} from '@plaudern/contracts';
import { CurrentDevice, DeviceAuthGuard, type DeviceContext } from '@plaudern/auth';
import { IngestionService } from './ingestion.service';

/**
 * Generic ingestion endpoints. `init`/`commit` drive the presigned upload for
 * any blob source (audio/file/plaud); `text` is the inline path. The concrete
 * behaviour per source lives in the adapters (plan §2).
 */
@Controller({ path: 'ingest', version: '1' })
@UseGuards(DeviceAuthGuard)
export class IngestionController {
  constructor(private readonly ingestion: IngestionService) {}

  @Post('init')
  async init(
    @CurrentDevice() device: DeviceContext,
    @Body() body: unknown,
  ): Promise<IngestInitResponse> {
    const req = ingestInitRequestSchema.parse(body);
    return this.ingestion.init(device, req);
  }

  @Post(':id/commit')
  async commit(
    @CurrentDevice() device: DeviceContext,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    return this.ingestion.commit(device, id);
  }

  @Post('text')
  async text(
    @CurrentDevice() device: DeviceContext,
    @Body() body: unknown,
  ): Promise<InboxItemDto> {
    const req: IngestTextRequest = ingestTextRequestSchema.parse(body);
    return this.ingestion.ingestText(device, req);
  }
}

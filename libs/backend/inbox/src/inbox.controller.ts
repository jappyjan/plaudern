import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  inboxListQuerySchema,
  type InboxItemDto,
  type InboxListResponse,
} from '@plaudern/contracts';
import { CurrentDevice, DeviceAuthGuard, type DeviceContext } from '@plaudern/auth';
import { StorageService } from '@plaudern/storage';
import { InboxService } from './inbox.service';
import { toInboxItemDto } from './inbox.mapper';

/** Read-only access to the immutable inbox. No write/update/delete routes exist. */
@Controller({ path: 'inbox', version: '1' })
@UseGuards(DeviceAuthGuard)
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(
    @CurrentDevice() device: DeviceContext,
    @Query() query: Record<string, unknown>,
  ): Promise<InboxListResponse> {
    const { limit, cursor } = inboxListQuerySchema.parse(query);
    const { items, nextCursor } = await this.inbox.listItems(device.userId, limit, cursor);
    return { items: items.map(toInboxItemDto), nextCursor };
  }

  @Get(':id')
  async get(
    @CurrentDevice() device: DeviceContext,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(device.userId, id);
    return toInboxItemDto(item);
  }

  /** Presigned GET URL for playback/download of the source blob. */
  @Get(':id/source-url')
  async sourceUrl(
    @CurrentDevice() device: DeviceContext,
    @Param('id') id: string,
  ): Promise<{ url: string | null }> {
    const item = await this.inbox.getItem(device.userId, id);
    if (!item.source) return { url: null };
    return { url: await this.storage.createPresignedGetUrl(item.source.storageKey) };
  }
}

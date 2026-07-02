import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  inboxListQuerySchema,
  type InboxItemDto,
  type InboxListResponse,
} from '@plaudern/contracts';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { StorageService } from '@plaudern/storage';
import { InboxService } from './inbox.service';
import { toInboxItemDto } from './inbox.mapper';

/** Read-only access to the immutable inbox. No write/update/delete routes exist. */
@Controller({ path: 'inbox', version: '1' })
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<InboxListResponse> {
    const { limit, cursor } = inboxListQuerySchema.parse(query);
    const { items, nextCursor } = await this.inbox.listItems(DEFAULT_USER_ID, limit, cursor);
    return { items: items.map(toInboxItemDto), nextCursor };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(DEFAULT_USER_ID, id);
    return toInboxItemDto(item);
  }

  /** Presigned GET URL for playback/download of the source blob. */
  @Get(':id/source-url')
  async sourceUrl(@Param('id') id: string): Promise<{ url: string | null }> {
    const item = await this.inbox.getItem(DEFAULT_USER_ID, id);
    if (!item.source) return { url: null };
    return { url: await this.storage.createPresignedGetUrl(item.source.storageKey) };
  }
}

import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import {
  inboxListQuerySchema,
  type InboxItemDto,
  type InboxListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { StorageService } from '@plaudern/storage';
import { InboxService } from './inbox.service';
import { toInboxItemDto } from './inbox.mapper';

/** Read access plus whole-item deletion. Items are never edited in place. */
@Controller({ path: 'inbox', version: '1' })
export class InboxController {
  constructor(
    private readonly inbox: InboxService,
    private readonly storage: StorageService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: Record<string, unknown>,
  ): Promise<InboxListResponse> {
    const { limit, cursor } = inboxListQuerySchema.parse(query);
    const { items, nextCursor } = await this.inbox.listItems(user.id, limit, cursor);
    return { items: items.map(toInboxItemDto), nextCursor };
  }

  @Get(':id')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<InboxItemDto> {
    const item = await this.inbox.getItem(user.id, id);
    return toInboxItemDto(item);
  }

  /** Permanently delete an item, its extractions and its stored blobs. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.inbox.deleteItem(user.id, id);
  }

  /** Presigned GET URL for playback/download of the source blob. */
  @Get(':id/source-url')
  async sourceUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<{ url: string | null }> {
    const item = await this.inbox.getItem(user.id, id);
    if (!item.source) return { url: null };
    return { url: await this.storage.createPresignedGetUrl(item.source.storageKey) };
  }
}

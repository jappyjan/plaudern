import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemDocMetaResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DocMetaService } from './docmeta.service';

/**
 * An item's document read model + manual re-extraction. Mounted on /inbox/:id
 * for symmetry with the transcript/summary/reminders routes; lives in this
 * module so the inbox lib stays free of any docmeta dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxDocMetaController {
  constructor(private readonly docmeta: DocMetaService) {}

  @Get(':id/docmeta')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemDocMetaResponse> {
    return this.docmeta.getItemDocMeta(user.id, id);
  }

  @Post(':id/docmeta/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemDocMetaResponse> {
    await this.docmeta.retry(user.id, id);
    return this.docmeta.getItemDocMeta(user.id, id);
  }
}

import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  updateDocumentDateOverrideRequestSchema,
  type ItemDocMetaResponse,
} from '@plaudern/contracts';
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

  @Patch(':id/docmeta/date')
  updateDate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ItemDocMetaResponse> {
    const parsed = updateDocumentDateOverrideRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid document date');
    }
    return this.docmeta.updateDateOverride(user.id, id, parsed.data);
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

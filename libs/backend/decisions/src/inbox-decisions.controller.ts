import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemDecisionsResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DecisionsService } from './decisions.service';

/**
 * An item's decisions read model + manual re-extraction. Mounted on /inbox/:id
 * for symmetry with the transcript/summary/questions routes; lives in this
 * module so the inbox lib stays free of any decisions dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxDecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get(':id/decisions')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemDecisionsResponse> {
    return this.decisions.getItemDecisions(user.id, id);
  }

  @Post(':id/decisions/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemDecisionsResponse> {
    await this.decisions.retry(user.id, id);
    return this.decisions.getItemDecisions(user.id, id);
  }
}

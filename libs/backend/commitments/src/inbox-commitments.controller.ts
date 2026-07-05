import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemCommitmentsResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { CommitmentsService } from './commitments.service';

/**
 * An item's commitments read model + manual re-extraction. Mounted on
 * /inbox/:id for symmetry with the transcript/summary/topics routes; lives in
 * this module so the inbox lib stays free of any commitments dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxCommitmentsController {
  constructor(private readonly commitments: CommitmentsService) {}

  @Get(':id/commitments')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemCommitmentsResponse> {
    return this.commitments.getItemCommitments(user.id, id);
  }

  @Post(':id/commitments/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemCommitmentsResponse> {
    await this.commitments.retry(user.id, id);
    return this.commitments.getItemCommitments(user.id, id);
  }
}

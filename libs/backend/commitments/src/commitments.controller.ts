import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
} from '@nestjs/common';
import {
  commitmentListQuerySchema,
  updateCommitmentStatusRequestSchema,
  type CommitmentDto,
  type CommitmentListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { CommitmentsService } from './commitments.service';

/**
 * The user's commitments across all recordings (JJ-36): a filterable list plus
 * a status update. No global ZodError filter exists, so requests are validated
 * with `.safeParse` and surfaced as 400s (mirrors the topics controller). The
 * per-item read model + retry live on /inbox/:id in InboxCommitmentsController.
 */
@Controller({ path: 'commitments', version: '1' })
export class CommitmentsController {
  constructor(private readonly commitments: CommitmentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<CommitmentListResponse> {
    const parsed = commitmentListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid filter');
    }
    return this.commitments.list(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CommitmentDto> {
    const parsed = updateCommitmentStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid status');
    }
    return this.commitments.updateStatus(user.id, id, parsed.data.status);
  }
}

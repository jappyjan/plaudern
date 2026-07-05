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
  decisionListQuerySchema,
  updateDecisionStatusRequestSchema,
  type DecisionDto,
  type DecisionListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { DecisionsService } from './decisions.service';

/**
 * The user's decision log across all recordings (JJ-33): a filterable, searchable
 * list plus a status update. No global ZodError filter exists, so requests are
 * validated with `.safeParse` and surfaced as 400s (mirrors the questions
 * controller). The per-item read model + retry live on /inbox/:id in
 * InboxDecisionsController.
 */
@Controller({ path: 'decisions', version: '1' })
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<DecisionListResponse> {
    const parsed = decisionListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid filter');
    }
    return this.decisions.list(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DecisionDto> {
    const parsed = updateDecisionStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid status');
    }
    return this.decisions.updateStatus(user.id, id, parsed.data.status);
  }
}

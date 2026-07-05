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
  questionListQuerySchema,
  updateQuestionStatusRequestSchema,
  type QuestionDto,
  type QuestionListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { QuestionsService } from './questions.service';

/**
 * The user's open questions across all recordings (JJ-34): a filterable list
 * plus a status update. No global ZodError filter exists, so requests are
 * validated with `.safeParse` and surfaced as 400s (mirrors the commitments
 * controller). The per-item read model + retry live on /inbox/:id in
 * InboxQuestionsController.
 */
@Controller({ path: 'questions', version: '1' })
export class QuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<QuestionListResponse> {
    const parsed = questionListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid filter');
    }
    return this.questions.list(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<QuestionDto> {
    const parsed = updateQuestionStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid status');
    }
    return this.questions.updateStatus(user.id, id, parsed.data.status);
  }
}

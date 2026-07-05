import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemQuestionsResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { QuestionsService } from './questions.service';

/**
 * An item's questions read model + manual re-extraction. Mounted on /inbox/:id
 * for symmetry with the transcript/summary/commitments routes; lives in this
 * module so the inbox lib stays free of any questions dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxQuestionsController {
  constructor(private readonly questions: QuestionsService) {}

  @Get(':id/questions')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemQuestionsResponse> {
    return this.questions.getItemQuestions(user.id, id);
  }

  @Post(':id/questions/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemQuestionsResponse> {
    await this.questions.retry(user.id, id);
    return this.questions.getItemQuestions(user.id, id);
  }
}

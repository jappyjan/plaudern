import { Controller, Get, Param, Post } from '@nestjs/common';
import type { SummaryDto } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { SummarizationService } from './summarization.service';

/**
 * Summary read model + manual regeneration. Mounted on /inbox/:id for symmetry
 * with the transcription and speaker-transcript routes; lives in this module so
 * the inbox lib stays free of any summarization dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class SummarizationController {
  constructor(private readonly summarization: SummarizationService) {}

  @Get(':id/summary')
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SummaryDto> {
    return this.summarization.getSummary(user.id, id);
  }

  @Post(':id/summary/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<SummaryDto> {
    await this.summarization.retrySummary(user.id, id);
    return this.summarization.getSummary(user.id, id);
  }
}

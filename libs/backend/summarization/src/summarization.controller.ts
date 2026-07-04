import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import {
  updateSummarizationSettingsRequestSchema,
  type SummarizationSettingsDto,
  type SummaryDto,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { SummarizationService } from './summarization.service';
import { SummarizationSettingsService } from './summarization-settings.service';

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

/** Per-user summarization preferences (currently the output language). */
@Controller({ path: 'settings/summarization', version: '1' })
export class SummarizationSettingsController {
  constructor(private readonly settings: SummarizationSettingsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser): Promise<SummarizationSettingsDto> {
    return this.settings.getDto(user.id);
  }

  @Put()
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<SummarizationSettingsDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = updateSummarizationSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid settings');
    }
    return this.settings.upsert(user.id, parsed.data);
  }
}

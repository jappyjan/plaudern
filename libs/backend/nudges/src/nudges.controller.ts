import { BadRequestException, Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { nudgeActionRequestSchema, type NudgeListResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { NudgesService } from './nudges.service';

/**
 * Commitment nudges (JJ-26): the user's active nudges for the ledger surface,
 * plus a dismiss/snooze action. No global ZodError filter exists, so bodies are
 * validated with `.safeParse` and surfaced as 400s (mirrors the open-loops /
 * commitments controllers). The `:commitmentId` is the underlying commitment id,
 * since a nudge has no id of its own (it's derived).
 */
@Controller({ path: 'nudges', version: '1' })
export class NudgesController {
  constructor(private readonly nudges: NudgesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<NudgeListResponse> {
    return this.nudges.listNudges(user.id);
  }

  @Patch(':commitmentId')
  async act(
    @CurrentUser() user: AuthenticatedUser,
    @Param('commitmentId') commitmentId: string,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = nudgeActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid action');
    }
    if (parsed.data.action === 'snooze' && parsed.data.snoozeDays === undefined) {
      throw new BadRequestException('snoozeDays is required to snooze a nudge');
    }
    await this.nudges.act(user.id, commitmentId, parsed.data);
    return { ok: true };
  }
}

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
  reminderListQuerySchema,
  updateReminderStatusRequestSchema,
  type ReminderDto,
  type ReminderListResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { RemindersService } from './reminders.service';

/**
 * The user's calendar-visible reminders across all recordings (JJ-25): a
 * filterable list (by status and/or due window) plus a status update. No global
 * ZodError filter exists, so requests are validated with `.safeParse` and
 * surfaced as 400s (mirrors the decisions controller). The per-item read model
 * + retry live on /inbox/:id in InboxRemindersController.
 */
@Controller({ path: 'reminders', version: '1' })
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: unknown,
  ): Promise<ReminderListResponse> {
    const parsed = reminderListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid filter');
    }
    return this.reminders.list(user.id, parsed.data);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ReminderDto> {
    const parsed = updateReminderStatusRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid status');
    }
    return this.reminders.updateStatus(user.id, id, parsed.data.status);
  }
}

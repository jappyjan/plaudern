import { Controller, Get, Param, Post } from '@nestjs/common';
import type { ItemRemindersResponse } from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { RemindersService } from './reminders.service';

/**
 * An item's reminders read model + manual re-extraction. Mounted on /inbox/:id
 * for symmetry with the transcript/summary/decisions routes; lives in this
 * module so the inbox lib stays free of any reminders dependency.
 */
@Controller({ path: 'inbox', version: '1' })
export class InboxRemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get(':id/reminders')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemRemindersResponse> {
    return this.reminders.getItemReminders(user.id, id);
  }

  @Post(':id/reminders/retry')
  async retry(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ItemRemindersResponse> {
    await this.reminders.retry(user.id, id);
    return this.reminders.getItemReminders(user.id, id);
  }
}

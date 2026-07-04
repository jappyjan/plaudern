import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
} from '@nestjs/common';
import {
  registerPushSubscriptionRequestSchema,
  sendTestNotificationRequestSchema,
  unregisterPushSubscriptionRequestSchema,
  updateNotificationPreferencesRequestSchema,
  type NotificationDispatchResult,
  type NotificationPreferencesDto,
  type VapidPublicKeyResponse,
} from '@plaudern/contracts';
import { CurrentUser, type AuthenticatedUser } from '@plaudern/auth';
import { NotificationsService } from './notifications.service';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushSubscriptionsService } from './push-subscriptions.service';

/**
 * Notification engine API: per-user preferences, web-push subscription
 * management, and a "send test notification" action so users can verify a
 * channel end-to-end. Content-producing proactive features call
 * `NotificationsService.notify()` directly, not this controller.
 */
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
    private readonly subscriptions: PushSubscriptionsService,
  ) {}

  @Get('preferences')
  getPreferences(@CurrentUser() user: AuthenticatedUser): Promise<NotificationPreferencesDto> {
    return this.notifications.getPreferencesDto(user.id);
  }

  @Put('preferences')
  async updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<NotificationPreferencesDto> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = updateNotificationPreferencesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid preferences');
    }
    await this.preferences.update(user.id, parsed.data);
    return this.notifications.getPreferencesDto(user.id);
  }

  @Get('push/public-key')
  vapidPublicKey(): VapidPublicKeyResponse {
    return this.notifications.vapidPublicKey();
  }

  @Post('push/subscriptions')
  async registerPush(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const parsed = registerPushSubscriptionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid subscription');
    }
    await this.subscriptions.register(user.id, parsed.data);
    return { ok: true };
  }

  @Delete('push/subscriptions')
  @HttpCode(204)
  async unregisterPush(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = unregisterPushSubscriptionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid endpoint');
    }
    await this.subscriptions.remove(user.id, parsed.data.endpoint);
  }

  @Post('test')
  async sendTest(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ): Promise<NotificationDispatchResult> {
    const parsed = sendTestNotificationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues[0]?.message ?? 'invalid request');
    }
    return this.notifications.notify(user.id, {
      category: parsed.data.category ?? 'morning_briefing',
      title: parsed.data.title ?? 'Test notification',
      body: parsed.data.body ?? 'This is a test notification from Plaudern.',
      channels: parsed.data.channels,
      // A test always tries the requested channels and ignores quiet hours /
      // caps so the user can verify delivery regardless of their settings.
      bypassGating: true,
    });
  }
}

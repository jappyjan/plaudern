import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  NotificationCategoryPreferenceEntity,
  NotificationDeliveryEntity,
  NotificationSettingsEntity,
  PushSubscriptionEntity,
} from '@plaudern/persistence';
import { NOTIFICATION_CHANNELS, type NotificationChannelHandler } from './channels/channel';
import { WEB_PUSH_SENDER, VapidWebPushSender } from './channels/web-push.sender';
import { EMAIL_SENDER, SmtpEmailSender } from './channels/email.sender';
import { BOT_SENDER, StubBotSender } from './channels/bot.sender';
import { WebPushChannel } from './channels/web-push.channel';
import { EmailChannel } from './channels/email.channel';
import { BotChannel } from './channels/bot.channel';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/**
 * The shared notification engine (ATT-661). Channels sit behind provider
 * tokens (WEB_PUSH_SENDER / EMAIL_SENDER / BOT_SENDER) so tests swap in fakes
 * via `overrideProvider`, and the real transports stay disabled until their
 * env config (VAPID / SMTP) is present.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      NotificationSettingsEntity,
      NotificationCategoryPreferenceEntity,
      PushSubscriptionEntity,
      NotificationDeliveryEntity,
    ]),
  ],
  providers: [
    // Transport seams (faked in tests).
    { provide: WEB_PUSH_SENDER, useClass: VapidWebPushSender },
    { provide: EMAIL_SENDER, useClass: SmtpEmailSender },
    { provide: BOT_SENDER, useClass: StubBotSender },
    // Channel handlers.
    WebPushChannel,
    EmailChannel,
    BotChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      inject: [WebPushChannel, EmailChannel, BotChannel],
      useFactory: (
        webPush: WebPushChannel,
        email: EmailChannel,
        bot: BotChannel,
      ): NotificationChannelHandler[] => [webPush, email, bot],
    },
    NotificationPreferencesService,
    PushSubscriptionsService,
    NotificationsService,
  ],
  controllers: [NotificationsController],
  // Exported so proactive features (briefings, nudges, …) can inject the engine.
  exports: [NotificationsService, NotificationPreferencesService, PushSubscriptionsService],
})
export class NotificationsModule {}

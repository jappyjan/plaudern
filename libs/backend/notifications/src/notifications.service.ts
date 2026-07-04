import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import {
  type ChannelDeliveryResult,
  type NotificationCategory,
  type NotificationChannel,
  type NotificationDispatchResult,
  type NotificationPreferencesDto,
} from '@plaudern/contracts';
import { NotificationDeliveryEntity } from '@plaudern/persistence';
import {
  NOTIFICATION_CHANNELS,
  type ChannelSendContext,
  type NotificationChannelHandler,
  type NotificationMessage,
} from './channels/channel';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { WEB_PUSH_SENDER, type WebPushSender } from './channels/web-push.sender';
import { isWithinQuietHours, quietHoursEndsAt } from './quiet-hours';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What a proactive feature hands the engine to deliver. */
export interface NotifyRequest {
  category: NotificationCategory;
  title: string;
  body: string;
  url?: string;
  data?: Record<string, unknown>;
  /**
   * Restrict delivery to this subset of channels. Defaults to the category's
   * opted-in channels. Channels here that aren't opted in are still gated out
   * unless `bypassGating` is set.
   */
  channels?: NotificationChannel[];
  /**
   * Skip opt-in, quiet-hours and frequency-cap gating (used by the "send test
   * notification" endpoint so a user can always verify a channel works). Test
   * sends are logged with status `test` so they never count against caps.
   */
  bypassGating?: boolean;
}

/**
 * The single delivery engine every proactive feature shares. Resolves the
 * user's preferences, enforces opt-in / quiet-hours / frequency-cap gating,
 * then fans the message out to the enabled + configured channels and logs the
 * dispatch (for the frequency cap and an audit trail).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly byChannel: Map<NotificationChannel, NotificationChannelHandler>;

  constructor(
    @Inject(NOTIFICATION_CHANNELS) channels: NotificationChannelHandler[],
    @Inject(WEB_PUSH_SENDER) private readonly webPushSender: WebPushSender,
    private readonly preferences: NotificationPreferencesService,
    private readonly subscriptions: PushSubscriptionsService,
    @InjectRepository(NotificationDeliveryEntity)
    private readonly deliveries: Repository<NotificationDeliveryEntity>,
  ) {
    this.byChannel = new Map(channels.map((handler) => [handler.channel, handler]));
  }

  /** Server-side channel configuration status, independent of any user. */
  channelStatus(): NotificationPreferencesDto['channelStatus'] {
    return {
      web_push: this.byChannel.get('web_push')?.isConfigured() ?? false,
      email: this.byChannel.get('email')?.isConfigured() ?? false,
      bot: this.byChannel.get('bot')?.isConfigured() ?? false,
    };
  }

  /** The read model for the preferences endpoint. */
  async getPreferencesDto(userId: string): Promise<NotificationPreferencesDto> {
    const resolved = await this.preferences.resolve(userId);
    const pushSubscriptionCount = await this.subscriptions.count(userId);
    return {
      timezone: resolved.timezone,
      emailAddress: resolved.emailAddress,
      quietHours: resolved.quietHours,
      categories: await this.preferences.listCategoryPreferences(userId),
      channelStatus: this.channelStatus(),
      pushSubscriptionCount,
    };
  }

  /** The VAPID public key browsers need to subscribe (null if unconfigured). */
  vapidPublicKey(): { publicKey: string | null; configured: boolean } {
    const publicKey = this.webPushSender.getPublicKey();
    return { publicKey, configured: this.webPushSender.isConfigured() };
  }

  /**
   * Deliver one notification, applying all gating. Never throws — every
   * outcome (including "suppressed") is reported in the result so callers /
   * schedulers can react (e.g. retry after `retryAfter`).
   */
  async notify(userId: string, req: NotifyRequest, now = new Date()): Promise<NotificationDispatchResult> {
    const resolved = await this.preferences.resolve(userId);
    const catPref =
      resolved.categories.get(req.category) ?? { category: req.category, channels: [], maxPerDay: null };

    const requested = req.channels ?? catPref.channels;
    const results: ChannelDeliveryResult[] = [];

    // Opt-in gate (skipped for test sends).
    const channelsToTry: NotificationChannel[] = [];
    for (const channel of dedupe(requested)) {
      if (req.bypassGating || catPref.channels.includes(channel)) {
        channelsToTry.push(channel);
      } else {
        results.push({ channel, status: 'opted_out', detail: 'not opted in for this category' });
      }
    }

    if (channelsToTry.length === 0) {
      return { category: req.category, outcome: 'no_channels', channels: results, retryAfter: null };
    }

    // Quiet-hours gate.
    if (
      !req.bypassGating &&
      resolved.quietHours.enabled &&
      isWithinQuietHours(now, resolved.timezone, resolved.quietHours.start, resolved.quietHours.end)
    ) {
      const retryAfter = quietHoursEndsAt(now, resolved.timezone, resolved.quietHours.end);
      return {
        category: req.category,
        outcome: 'suppressed_quiet_hours',
        channels: results,
        retryAfter: retryAfter.toISOString(),
      };
    }

    // Frequency-cap gate (per category, rolling 24h, counting `sent` rows only).
    if (!req.bypassGating && catPref.maxPerDay !== null) {
      const since = new Date(now.getTime() - DAY_MS);
      const recent = await this.deliveries.count({
        where: { userId, category: req.category, status: 'sent', createdAt: MoreThan(since) },
      });
      if (recent >= catPref.maxPerDay) {
        return {
          category: req.category,
          outcome: 'frequency_capped',
          channels: results,
          retryAfter: null,
        };
      }
    }

    // Fan out.
    const message: NotificationMessage = {
      category: req.category,
      title: req.title,
      body: req.body,
      url: req.url,
      data: req.data,
    };
    const ctx: ChannelSendContext = { userId, emailAddress: resolved.emailAddress };
    const sentChannels: NotificationChannel[] = [];
    let anyFailed = false;

    for (const channel of channelsToTry) {
      const handler = this.byChannel.get(channel);
      if (!handler) {
        results.push({ channel, status: 'not_configured', detail: 'unknown channel' });
        continue;
      }
      const result = await handler.send(ctx, message);
      results.push({ channel, status: result.status, detail: result.detail ?? null });
      if (result.status === 'sent') sentChannels.push(channel);
      if (result.status === 'failed') anyFailed = true;
    }

    // Log the dispatch: `sent`/`test` rows feed the frequency cap, `failed`
    // rows are audit-only (they must not block a retry).
    if (sentChannels.length > 0) {
      await this.deliveries.save(
        this.deliveries.create({
          userId,
          category: req.category,
          channels: sentChannels,
          status: req.bypassGating ? 'test' : 'sent',
        }),
      );
    } else if (anyFailed) {
      await this.deliveries.save(
        this.deliveries.create({
          userId,
          category: req.category,
          channels: [],
          status: 'failed',
        }),
      );
    }

    const outcome = sentChannels.length > 0 ? 'sent' : anyFailed ? 'failed' : 'no_channels';
    return { category: req.category, outcome, channels: results, retryAfter: null };
  }
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

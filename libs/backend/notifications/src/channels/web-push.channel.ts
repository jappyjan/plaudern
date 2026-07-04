import { Inject, Injectable, Logger } from '@nestjs/common';
import type { NotificationChannel } from '@plaudern/contracts';
import { PushSubscriptionsService } from '../push-subscriptions.service';
import type {
  ChannelSendContext,
  ChannelSendResult,
  NotificationChannelHandler,
  NotificationMessage,
} from './channel';
import {
  PushSubscriptionGoneError,
  WEB_PUSH_SENDER,
  type WebPushSender,
} from './web-push.sender';

/**
 * Web-push channel: fans a notification out to every browser/device the user
 * has subscribed. Dead subscriptions (HTTP 404/410) are pruned in-flight so
 * they don't accumulate.
 */
@Injectable()
export class WebPushChannel implements NotificationChannelHandler {
  readonly channel: NotificationChannel = 'web_push';
  private readonly logger = new Logger(WebPushChannel.name);

  constructor(
    @Inject(WEB_PUSH_SENDER) private readonly sender: WebPushSender,
    private readonly subscriptions: PushSubscriptionsService,
  ) {}

  isConfigured(): boolean {
    return this.sender.isConfigured();
  }

  async send(ctx: ChannelSendContext, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.sender.isConfigured()) {
      return { status: 'not_configured', detail: 'VAPID keys not set' };
    }
    const subs = await this.subscriptions.list(ctx.userId);
    if (subs.length === 0) {
      return { status: 'no_target', detail: 'no registered devices' };
    }
    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      url: message.url ?? null,
      category: message.category,
      data: message.data ?? null,
    });

    let sent = 0;
    let failed = 0;
    let pruned = 0;
    for (const sub of subs) {
      try {
        await this.sender.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent += 1;
      } catch (err) {
        if (err instanceof PushSubscriptionGoneError) {
          await this.subscriptions.pruneByEndpoint(sub.endpoint);
          pruned += 1;
        } else {
          failed += 1;
          this.logger.warn(
            `web push to ${sub.endpoint} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    if (sent > 0) return { status: 'sent', detail: `${sent} device(s)` };
    if (failed > 0) return { status: 'failed', detail: 'all push sends failed' };
    return { status: 'no_target', detail: `${pruned} expired subscription(s) pruned` };
  }
}

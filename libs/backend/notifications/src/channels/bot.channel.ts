import { Inject, Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@plaudern/contracts';
import type {
  ChannelSendContext,
  ChannelSendResult,
  NotificationChannelHandler,
  NotificationMessage,
} from './channel';
import { BOT_SENDER, type BotSender } from './bot.sender';

/**
 * Messaging-bot channel. Wired into the engine today but backed by a stub
 * sender until the bot integration (ATT-693) lands, so it resolves to
 * `not_configured` and the engine simply skips it.
 */
@Injectable()
export class BotChannel implements NotificationChannelHandler {
  readonly channel: NotificationChannel = 'bot';

  constructor(@Inject(BOT_SENDER) private readonly sender: BotSender) {}

  isConfigured(): boolean {
    return this.sender.isConfigured();
  }

  async send(ctx: ChannelSendContext, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.sender.isConfigured()) {
      return { status: 'not_configured', detail: 'messaging bot not yet available' };
    }
    try {
      await this.sender.send(ctx.userId, {
        title: message.title,
        body: message.body,
        url: message.url,
      });
      return { status: 'sent' };
    } catch (err) {
      return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

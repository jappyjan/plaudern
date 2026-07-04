import { Injectable } from '@nestjs/common';

export interface BotMessage {
  title: string;
  body: string;
  url?: string;
}

/**
 * Messaging-bot transport (Telegram first — ATT-693). Defined here so the
 * engine can already fan out to a `bot` channel and users can opt into it in
 * their preferences; the concrete implementation lands with the bot feature.
 */
export interface BotSender {
  isConfigured(): boolean;
  send(userId: string, message: BotMessage): Promise<void>;
}

export const BOT_SENDER = Symbol('BOT_SENDER');

/**
 * Stub bot sender: always unconfigured, so the bot channel resolves to
 * `not_configured` until ATT-693 provides a real transport. Kept as a real
 * provider (not just an interface) so the DI graph is complete today.
 */
@Injectable()
export class StubBotSender implements BotSender {
  isConfigured(): boolean {
    return false;
  }

  async send(): Promise<void> {
    throw new Error('messaging bot channel is not yet implemented (see ATT-693)');
  }
}

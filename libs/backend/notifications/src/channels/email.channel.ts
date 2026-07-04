import { Inject, Injectable } from '@nestjs/common';
import type { NotificationChannel } from '@plaudern/contracts';
import type {
  ChannelSendContext,
  ChannelSendResult,
  NotificationChannelHandler,
  NotificationMessage,
} from './channel';
import { EMAIL_SENDER, type EmailSender } from './email.sender';

/** Email channel: delivers to the user's configured delivery address. */
@Injectable()
export class EmailChannel implements NotificationChannelHandler {
  readonly channel: NotificationChannel = 'email';

  constructor(@Inject(EMAIL_SENDER) private readonly sender: EmailSender) {}

  isConfigured(): boolean {
    return this.sender.isConfigured();
  }

  async send(ctx: ChannelSendContext, message: NotificationMessage): Promise<ChannelSendResult> {
    if (!this.sender.isConfigured()) {
      return { status: 'not_configured', detail: 'SMTP not set' };
    }
    if (!ctx.emailAddress) {
      return { status: 'no_target', detail: 'no delivery email address set' };
    }
    const html = message.url
      ? `<p>${escapeHtml(message.body)}</p><p><a href="${escapeHtml(message.url)}">Open in Plaudern</a></p>`
      : `<p>${escapeHtml(message.body)}</p>`;
    try {
      await this.sender.send({
        to: ctx.emailAddress,
        subject: message.title,
        text: message.url ? `${message.body}\n\n${message.url}` : message.body,
        html,
      });
      return { status: 'sent', detail: ctx.emailAddress };
    } catch (err) {
      return { status: 'failed', detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

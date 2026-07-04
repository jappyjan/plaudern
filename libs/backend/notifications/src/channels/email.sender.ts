import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Low-level SMTP transport — the seam tests replace with a fake so the email
 * channel is exercised end-to-end without a real mail server.
 */
export interface EmailSender {
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

/**
 * Real SMTP sender (nodemailer). Configured via `SMTP_HOST` / `SMTP_PORT` /
 * `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM`; without a host the channel
 * reports unconfigured and the engine skips it.
 */
@Injectable()
export class SmtpEmailSender implements EmailSender {
  private readonly logger = new Logger(SmtpEmailSender.name);
  private readonly transporter: Transporter | null;
  private readonly from: string;

  constructor(config: ConfigService) {
    const host = config.get<string>('SMTP_HOST', '');
    this.from = config.get<string>('SMTP_FROM', 'Plaudern <notifications@plaudern.local>');
    if (!host) {
      this.transporter = null;
      return;
    }
    const port = Number(config.get<string>('SMTP_PORT', '587'));
    const user = config.get<string>('SMTP_USER', '');
    const pass = config.get<string>('SMTP_PASSWORD', '');
    this.transporter = createTransport({
      host,
      port,
      // Implicit TLS on 465; STARTTLS otherwise.
      secure: config.get<string>('SMTP_SECURE', port === 465 ? 'true' : 'false') === 'true',
      auth: user ? { user, pass } : undefined,
    });
    this.logger.log(`email configured (SMTP host ${host}:${port})`);
  }

  isConfigured(): boolean {
    return this.transporter !== null;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!this.transporter) throw new Error('email not configured');
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

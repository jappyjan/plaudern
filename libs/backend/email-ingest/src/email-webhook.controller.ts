import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from '@plaudern/auth';
import { emailWebhookJsonBodySchema } from './email-webhook.schemas';
import { EmailWebhookService, type EmailWebhookResult } from './email-webhook.service';

const SECRET_HEADER = 'x-webhook-secret';

/**
 * Inbound email endpoint (plan §2, `sources/email`). Deliberately `@Public()`:
 * this is called by a mail-relay/inbound-parse provider, not a logged-in user,
 * so it authenticates via a shared secret (`EMAIL_WEBHOOK_SECRET`) instead of
 * a session cookie — there is no per-request user identity until the email
 * itself is parsed and its `inbox+<token>@` recipient resolves one.
 *
 * Body shape (see `email-webhook.schemas.ts`): either the raw MIME source
 * directly (`Content-Type: message/rfc822` or `text/plain` — captured as a
 * Buffer by an `express.raw()` middleware in `main.ts`) or a SendGrid/SES-style
 * JSON wrapper `{ raw, isBase64 }`.
 */
@Controller({ path: 'webhooks/email', version: '1' })
export class EmailWebhookController {
  constructor(
    private readonly webhook: EmailWebhookService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Headers(SECRET_HEADER) providedSecret: string | undefined,
    @Body() body: unknown,
  ): Promise<EmailWebhookResult> {
    this.assertSecret(providedSecret);
    return this.webhook.handleRawEmail(this.extractRawMime(body));
  }

  private assertSecret(provided: string | undefined): void {
    const expected = this.config.get<string>('EMAIL_WEBHOOK_SECRET', '');
    if (!expected) {
      throw new ServiceUnavailableException(
        'EMAIL_WEBHOOK_SECRET is not configured on the server — the email-in webhook is disabled',
      );
    }
    const providedBuf = Buffer.from(provided ?? '', 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const matches =
      providedBuf.length === expectedBuf.length && timingSafeEqual(providedBuf, expectedBuf);
    if (!matches) throw new UnauthorizedException('invalid webhook secret');
  }

  private extractRawMime(body: unknown): Buffer | string {
    if (typeof body === 'string') return body;
    if (Buffer.isBuffer(body)) return body;
    if (body && typeof body === 'object') {
      const { raw, isBase64 } = emailWebhookJsonBodySchema.parse(body);
      return isBase64 ? Buffer.from(raw, 'base64') : raw;
    }
    throw new BadRequestException(
      'expected a raw MIME body or a JSON { raw, isBase64 } wrapper',
    );
  }
}

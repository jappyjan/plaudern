import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { simpleParser, type AddressObject, type EmailAddress, type ParsedMail } from 'mailparser';
import { InboxService } from '@plaudern/inbox';
import { IngestionService } from '@plaudern/ingestion';
import { StorageService } from '@plaudern/storage';
import { EmailSettingsService } from './email-settings.service';
import { buildEmailAttachmentStorageKey } from './storage-key';

const ADDRESS_TAG_PATTERN = /^inbox\+([a-zA-Z0-9_-]+)@/i;

export interface EmailWebhookResult {
  inboxItemId: string | null;
  /** True when the email was a no-op: unknown recipient, or already handled. */
  skipped: boolean;
  reason?: 'tombstoned' | 'duplicate';
}

/**
 * Turns one raw MIME email into one inbox item (plan §2, `sources/email`).
 * Mirrors the shape of `PlaudSyncService`: idempotency via a stable key,
 * tombstones respected so a deleted item is never resurrected by a redelivery,
 * and the actual envelope creation delegated to the generic ingestion path
 * (`IngestionService.ingestBlob`) so email gets the exact same guarantees
 * (immutable envelope, per-user scoping) as every other source.
 */
@Injectable()
export class EmailWebhookService {
  private readonly logger = new Logger(EmailWebhookService.name);

  constructor(
    private readonly settings: EmailSettingsService,
    private readonly inbox: InboxService,
    private readonly ingestion: IngestionService,
    private readonly storage: StorageService,
  ) {}

  async handleRawEmail(raw: Buffer | string): Promise<EmailWebhookResult> {
    const parsed = await simpleParser(raw);

    const token = this.extractToken(parsed);
    if (!token) {
      throw new BadRequestException(
        'no inbox+<token>@<domain> recipient found in the To/Cc headers',
      );
    }

    const userId = await this.settings.resolveUserId(token);
    if (!userId) {
      throw new NotFoundException('unknown or disabled email-in address');
    }

    const idempotencyKey = `email:${this.messageIdFor(parsed, raw)}`;

    if (await this.inbox.isIdempotencyKeyTombstoned(userId, idempotencyKey)) {
      this.logger.log(`email webhook: skipping tombstoned item (${idempotencyKey})`);
      return { inboxItemId: null, skipped: true, reason: 'tombstoned' };
    }

    const existing = await this.inbox.findByIdempotencyKey(userId, idempotencyKey);
    if (existing) {
      // Redelivery of an email we've already ingested — never re-upload
      // attachments for it.
      return { inboxItemId: existing.id, skipped: true, reason: 'duplicate' };
    }

    const attachments = await this.storeAttachments(userId, parsed);
    const occurredAt = (parsed.date ?? new Date()).toISOString();
    const subject = parsed.subject ?? '(no subject)';
    const bodyText = parsed.text ?? '';
    const payload = `Subject: ${subject}\n\n${bodyText}`;

    const item = await this.ingestion.ingestBlob(userId, {
      sourceType: 'email',
      body: Buffer.from(payload, 'utf8'),
      contentType: 'text/plain',
      occurredAt,
      idempotencyKey,
      metadata: {
        subject,
        from: addressText(parsed.from),
        to: recipientAddresses(parsed).map((addr) => addr.address).filter(Boolean),
        attachments,
        importedVia: 'email-in',
      },
    });

    return { inboxItemId: item.id, skipped: false };
  }

  private async storeAttachments(
    userId: string,
    parsed: ParsedMail,
  ): Promise<Array<{ storageKey: string; filename: string | null; contentType: string; byteSize: number }>> {
    const stored: Array<{
      storageKey: string;
      filename: string | null;
      contentType: string;
      byteSize: number;
    }> = [];
    for (const attachment of parsed.attachments) {
      const filename = attachment.filename ?? null;
      const storageKey = buildEmailAttachmentStorageKey(userId, filename);
      await this.storage.putObject(storageKey, attachment.content, attachment.contentType);
      stored.push({
        storageKey,
        filename,
        contentType: attachment.contentType,
        byteSize: attachment.content.byteLength,
      });
    }
    return stored;
  }

  /** First `inbox+<token>@...` match across To then Cc. */
  private extractToken(parsed: ParsedMail): string | null {
    for (const addr of recipientAddresses(parsed)) {
      const match = addr.address ? ADDRESS_TAG_PATTERN.exec(addr.address) : null;
      if (match) return match[1];
    }
    return null;
  }

  /** Message-ID when present (the norm); a content hash otherwise so idempotency still holds. */
  private messageIdFor(parsed: ParsedMail, raw: Buffer | string): string {
    if (parsed.messageId) return parsed.messageId;
    const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
    return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
  }
}

function recipientAddresses(parsed: ParsedMail): EmailAddress[] {
  return [...toArray(parsed.to), ...toArray(parsed.cc)].flatMap((addr) => addr.value);
}

function toArray(value: AddressObject | AddressObject[] | undefined): AddressObject[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function addressText(value: AddressObject | undefined): string | null {
  return value?.text ?? null;
}

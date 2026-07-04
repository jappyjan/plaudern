import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailWebhookService } from './email-webhook.service';

type Fakes = {
  settings: { resolveUserId: jest.Mock };
  inbox: { isIdempotencyKeyTombstoned: jest.Mock; findByIdempotencyKey: jest.Mock };
  ingestion: { ingestBlob: jest.Mock };
  storage: { putObject: jest.Mock };
};

function build(): { service: EmailWebhookService; fakes: Fakes } {
  const fakes: Fakes = {
    settings: { resolveUserId: jest.fn().mockResolvedValue('user-1') },
    inbox: {
      isIdempotencyKeyTombstoned: jest.fn().mockResolvedValue(false),
      findByIdempotencyKey: jest.fn().mockResolvedValue(null),
    },
    ingestion: { ingestBlob: jest.fn().mockResolvedValue({ id: 'item-1' }) },
    storage: { putObject: jest.fn().mockResolvedValue(undefined) },
  };
  const service = new EmailWebhookService(
    fakes.settings as never,
    fakes.inbox as never,
    fakes.ingestion as never,
    fakes.storage as never,
  );
  return { service, fakes };
}

const PLAIN_EMAIL = [
  'From: Alice <alice@example.com>',
  'To: inbox+abc123@in.example.com',
  'Subject: Dentist appointment confirmed',
  'Message-ID: <msg-1@example.com>',
  'Date: Wed, 01 Jul 2026 09:00:00 +0000',
  'Content-Type: text/plain; charset="utf-8"',
  '',
  'See you Friday at 10am.',
  '',
].join('\r\n');

function withAttachment(messageId: string, filename: string, content: string): string {
  const boundary = 'BOUNDARY123';
  return [
    'From: Alice <alice@example.com>',
    'To: inbox+abc123@in.example.com',
    'Subject: Invoice attached',
    `Message-ID: <${messageId}@example.com>`,
    'Date: Wed, 01 Jul 2026 09:00:00 +0000',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    'Please find the invoice attached.',
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(content).toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

const NO_RECIPIENT_MATCH_EMAIL = [
  'From: Alice <alice@example.com>',
  'To: someone-else@in.example.com',
  'Subject: Not for us',
  'Message-ID: <msg-none@example.com>',
  'Date: Wed, 01 Jul 2026 09:00:00 +0000',
  'Content-Type: text/plain',
  '',
  'body',
  '',
].join('\r\n');

const NO_MESSAGE_ID_EMAIL = [
  'From: Alice <alice@example.com>',
  'To: inbox+abc123@in.example.com',
  'Subject: No message id here',
  'Date: Wed, 01 Jul 2026 09:00:00 +0000',
  'Content-Type: text/plain',
  '',
  'body text',
  '',
].join('\r\n');

describe('EmailWebhookService', () => {
  it('creates one inbox item from a plain email, using the Date header as occurredAt', async () => {
    const { service, fakes } = build();

    const result = await service.handleRawEmail(PLAIN_EMAIL);

    expect(result).toEqual({ inboxItemId: 'item-1', skipped: false });
    expect(fakes.settings.resolveUserId).toHaveBeenCalledWith('abc123');
    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        sourceType: 'email',
        idempotencyKey: 'email:<msg-1@example.com>',
        occurredAt: '2026-07-01T09:00:00.000Z',
        contentType: 'text/plain',
        metadata: expect.objectContaining({
          subject: 'Dentist appointment confirmed',
          importedVia: 'email-in',
          attachments: [],
        }),
      }),
    );
    const body = (fakes.ingestion.ingestBlob.mock.calls[0][1].body as Buffer).toString('utf8');
    expect(body).toContain('Subject: Dentist appointment confirmed');
    expect(body).toContain('See you Friday at 10am.');
  });

  it('rejects when no inbox+<token>@ recipient is found', async () => {
    const { service } = build();
    await expect(service.handleRawEmail(NO_RECIPIENT_MATCH_EMAIL)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects when the token does not resolve to a user (unknown or disabled)', async () => {
    const { service, fakes } = build();
    fakes.settings.resolveUserId.mockResolvedValue(null);
    await expect(service.handleRawEmail(PLAIN_EMAIL)).rejects.toBeInstanceOf(NotFoundException);
    expect(fakes.ingestion.ingestBlob).not.toHaveBeenCalled();
  });

  it('stores attachments via the storage abstraction and references them in metadata', async () => {
    const { service, fakes } = build();
    const raw = withAttachment('msg-2', 'invoice.pdf', 'PDF-BYTES');

    await service.handleRawEmail(raw);

    expect(fakes.storage.putObject).toHaveBeenCalledTimes(1);
    const [storageKey, content, contentType] = fakes.storage.putObject.mock.calls[0];
    expect(storageKey).toMatch(/^inbox\/user-1\/.+\/attachments\/invoice\.pdf$/);
    expect(Buffer.from(content).toString('utf8')).toBe('PDF-BYTES');
    expect(contentType).toBe('application/pdf');

    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        idempotencyKey: 'email:<msg-2@example.com>',
        metadata: expect.objectContaining({
          attachments: [
            expect.objectContaining({
              storageKey,
              filename: 'invoice.pdf',
              contentType: 'application/pdf',
              byteSize: Buffer.from('PDF-BYTES').byteLength,
            }),
          ],
        }),
      }),
    );
  });

  it('is idempotent via Message-ID: a redelivery does not re-store attachments or re-ingest', async () => {
    const { service, fakes } = build();
    const raw = withAttachment('msg-3', 'invoice.pdf', 'PDF-BYTES');
    fakes.inbox.findByIdempotencyKey.mockResolvedValue({ id: 'already-there' });

    const result = await service.handleRawEmail(raw);

    expect(result).toEqual({ inboxItemId: 'already-there', skipped: true, reason: 'duplicate' });
    expect(fakes.storage.putObject).not.toHaveBeenCalled();
    expect(fakes.ingestion.ingestBlob).not.toHaveBeenCalled();
  });

  it('respects tombstones: a redelivered-but-deleted item is skipped, not resurrected', async () => {
    const { service, fakes } = build();
    fakes.inbox.isIdempotencyKeyTombstoned.mockResolvedValue(true);

    const result = await service.handleRawEmail(PLAIN_EMAIL);

    expect(result).toEqual({ inboxItemId: null, skipped: true, reason: 'tombstoned' });
    expect(fakes.inbox.findByIdempotencyKey).not.toHaveBeenCalled();
    expect(fakes.ingestion.ingestBlob).not.toHaveBeenCalled();
  });

  it('falls back to a content hash idempotency key when Message-ID is missing', async () => {
    const { service, fakes } = build();

    await service.handleRawEmail(NO_MESSAGE_ID_EMAIL);

    expect(fakes.ingestion.ingestBlob).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^email:sha256:[0-9a-f]{64}$/) }),
    );
  });
});

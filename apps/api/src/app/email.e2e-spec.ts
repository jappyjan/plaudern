import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init).
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.APP_ENCRYPTION_SECRET = 'test-secret';
process.env.EMAIL_INBOUND_DOMAIN = 'in.example.com';
process.env.EMAIL_WEBHOOK_SECRET = 'whsec_test_only';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { createE2eApp } from '../testing/e2e-app';

function rawEmail(opts: {
  to: string;
  messageId?: string;
  subject?: string;
  text?: string;
  attachment?: { filename: string; contentType: string; content: string };
}): string {
  const messageIdLine = opts.messageId ? [`Message-ID: <${opts.messageId}@example.com>`] : [];
  if (!opts.attachment) {
    return [
      'From: Alice <alice@example.com>',
      `To: ${opts.to}`,
      `Subject: ${opts.subject ?? 'Test'}`,
      ...messageIdLine,
      'Date: Wed, 01 Jul 2026 09:00:00 +0000',
      'Content-Type: text/plain; charset="utf-8"',
      '',
      opts.text ?? 'body',
      '',
    ].join('\r\n');
  }

  const boundary = 'E2EBOUNDARY';
  return [
    'From: Alice <alice@example.com>',
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? 'Test'}`,
    ...messageIdLine,
    'Date: Wed, 01 Jul 2026 09:00:00 +0000',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    '',
    opts.text ?? 'body',
    '',
    `--${boundary}`,
    `Content-Type: ${opts.attachment.contentType}; name="${opts.attachment.filename}"`,
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(opts.attachment.content).toString('base64'),
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

describe('Email-in settings + webhook (e2e)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp();
    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  it('starts unconfigured', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    expect(res.body).toEqual({ configured: false, enabled: false, address: null });
  });

  it('generates an address on the first rotate call', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/settings/email/rotate')
      .expect(201);
    expect(res.body.configured).toBe(true);
    expect(res.body.enabled).toBe(true);
    expect(res.body.address).toMatch(/^inbox\+[A-Za-z0-9_-]+@in\.example\.com$/);

    // GET reflects the same, stable address (not a one-time reveal).
    const get = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    expect(get.body.address).toBe(res.body.address);
  });

  it('rejects the webhook without the correct secret', async () => {
    const get = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: get.body.address }))
      .expect(401);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'wrong-secret')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: get.body.address }))
      .expect(401);
  });

  it('ingests a raw-MIME email into the inbox as one item, with attachments stored', async () => {
    const settings = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    const address = settings.body.address as string;

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(
        rawEmail({
          to: address,
          messageId: 'invoice-1',
          subject: 'Your invoice',
          text: 'Please find the invoice attached.',
          attachment: { filename: 'invoice.pdf', contentType: 'application/pdf', content: 'PDF-BYTES' },
        }),
      )
      .expect(201);

    expect(res.body.skipped).toBe(false);
    expect(res.body.inboxItemId).toEqual(expect.any(String));

    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    const emailItems = inbox.body.items.filter(
      (item: { sourceType: string }) => item.sourceType === 'email',
    );
    expect(emailItems).toHaveLength(1);
    const item = emailItems[0];
    expect(item.occurredAt).toBe('2026-07-01T09:00:00.000Z');
    expect(item.source.uploadStatus).toBe('committed');
    expect(item.metadata.subject).toBe('Your invoice');
    expect(item.metadata.importedVia).toBe('email-in');
    expect(item.metadata.attachments).toHaveLength(1);

    const attachmentMeta = item.metadata.attachments[0];
    expect(attachmentMeta).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf' });
    const stored = await storage.headObject(attachmentMeta.storageKey);
    expect(stored.exists).toBe(true);
    expect(stored.byteSize).toBe(Buffer.from('PDF-BYTES').byteLength);

    // The email body enters the extraction DAG as a passthrough transcription,
    // so emails get the same downstream processing as every other source.
    const transcription = item.extractions.find(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(transcription.status).toBe('succeeded');
    expect(transcription.provider).toBe('text-passthrough');
    expect(transcription.content).toContain('Please find the invoice attached.');
  });

  it('redelivering the same Message-ID is idempotent (no duplicate item, no re-upload)', async () => {
    const settings = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    const address = settings.body.address as string;

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: address, messageId: 'invoice-1', subject: 'Your invoice (resend)' }))
      .expect(201);

    expect(res.body).toMatchObject({ skipped: true, reason: 'duplicate' });

    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    expect(
      inbox.body.items.filter((item: { sourceType: string }) => item.sourceType === 'email'),
    ).toHaveLength(1);
  });

  it('deleting the item tombstones it so a redelivery is skipped, not resurrected', async () => {
    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    const item = inbox.body.items.find((i: { sourceType: string }) => i.sourceType === 'email');
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${item.id}`).expect(204);

    const settings = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: settings.body.address as string, messageId: 'invoice-1' }))
      .expect(201);

    expect(res.body).toMatchObject({ skipped: true, reason: 'tombstoned' });
    const after = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    expect(
      after.body.items.filter((i: { sourceType: string }) => i.sourceType === 'email'),
    ).toHaveLength(0);
  });

  it('rejects an email for an unknown token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: 'inbox+doesnotexist@in.example.com', messageId: 'unknown-1' }))
      .expect(404);
  });

  it('disabling the address makes the webhook reject new mail for it', async () => {
    const settings = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);

    await request(app.getHttpServer())
      .put('/api/v1/settings/email')
      .send({ enabled: false })
      .expect(200);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: settings.body.address as string, messageId: 'disabled-1' }))
      .expect(404);

    // Re-enable so it doesn't leak state into a hypothetical next test.
    await request(app.getHttpServer())
      .put('/api/v1/settings/email')
      .send({ enabled: true })
      .expect(200);
  });

  it('rotating invalidates the old address', async () => {
    const before = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);

    const rotated = await request(app.getHttpServer())
      .post('/api/v1/settings/email/rotate')
      .expect(201);
    expect(rotated.body.address).not.toBe(before.body.address);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: before.body.address as string, messageId: 'after-rotate-1' }))
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .set('Content-Type', 'message/rfc822')
      .send(rawEmail({ to: rotated.body.address as string, messageId: 'after-rotate-2' }))
      .expect(201);
  });

  it('accepts a SendGrid/SES-style JSON body with a base64-encoded raw MIME payload', async () => {
    const settings = await request(app.getHttpServer()).get('/api/v1/settings/email').expect(200);
    const raw = rawEmail({
      to: settings.body.address as string,
      messageId: 'json-wrapper-1',
      subject: 'Via JSON wrapper',
    });

    const res = await request(app.getHttpServer())
      .post('/api/v1/webhooks/email')
      .set('x-webhook-secret', 'whsec_test_only')
      .send({ raw: Buffer.from(raw).toString('base64') })
      .expect(201);

    expect(res.body.skipped).toBe(false);
  });
});

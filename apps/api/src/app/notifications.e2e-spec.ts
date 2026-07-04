import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init).
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.APP_ENCRYPTION_SECRET = 'test-secret';
process.env.PLAUD_POLL_INTERVAL_MS = '0'; // no background pollers in tests
process.env.CALENDAR_POLL_INTERVAL_MS = '0';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  EMAIL_SENDER,
  WEB_PUSH_SENDER,
  type EmailMessage,
  type WebPushTarget,
} from '@plaudern/notifications';
import { createE2eApp } from '../testing/e2e-app';

/** Fake VAPID sender: records payloads, reports "configured" with a key. */
class FakeWebPushSender {
  readonly sent: { target: WebPushTarget; payload: string }[] = [];
  isConfigured() {
    return true;
  }
  getPublicKey() {
    return 'FAKE_VAPID_PUBLIC_KEY';
  }
  async send(target: WebPushTarget, payload: string) {
    this.sent.push({ target, payload });
  }
}

/** Fake SMTP sender: records the messages it would have sent. */
class FakeEmailSender {
  readonly sent: EmailMessage[] = [];
  isConfigured() {
    return true;
  }
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/sub/abc123',
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};

describe('Notification engine (e2e)', () => {
  let app: INestApplication;
  const webPush = new FakeWebPushSender();
  const email = new FakeEmailSender();

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(WEB_PUSH_SENDER)
        .useValue(webPush)
        .overrideProvider(EMAIL_SENDER)
        .useValue(email),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns sensible defaults before any configuration', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .expect(200);
    expect(res.body.timezone).toBe('UTC');
    expect(res.body.emailAddress).toBeNull();
    expect(res.body.quietHours).toEqual({ enabled: true, start: '22:00', end: '07:00' });
    expect(res.body.channelStatus).toEqual({ web_push: true, email: true, bot: false });
    expect(res.body.pushSubscriptionCount).toBe(0);
    // Every category present with its default.
    const morning = res.body.categories.find(
      (c: { category: string }) => c.category === 'morning_briefing',
    );
    expect(morning).toEqual({ category: 'morning_briefing', channels: ['web_push'], maxPerDay: 1 });
  });

  it('exposes the VAPID public key', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/push/public-key')
      .expect(200);
    expect(res.body).toEqual({ publicKey: 'FAKE_VAPID_PUBLIC_KEY', configured: true });
  });

  it('persists updated preferences', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/notifications/preferences')
      .send({
        timezone: 'Europe/Berlin',
        emailAddress: 'user@example.com',
        quietHours: { enabled: false, start: '23:00', end: '06:00' },
        categories: [
          { category: 'weekly_digest', channels: ['web_push', 'email'], maxPerDay: 3 },
        ],
      })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .expect(200);
    expect(res.body.timezone).toBe('Europe/Berlin');
    expect(res.body.emailAddress).toBe('user@example.com');
    expect(res.body.quietHours.enabled).toBe(false);
    const digest = res.body.categories.find(
      (c: { category: string }) => c.category === 'weekly_digest',
    );
    expect(digest).toEqual({ category: 'weekly_digest', channels: ['web_push', 'email'], maxPerDay: 3 });
  });

  it('rejects malformed preference updates with 400', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/notifications/preferences')
      .send({ quietHours: { enabled: true, start: '25:00', end: '06:00' } })
      .expect(400);
  });

  it('registers a web-push subscription', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/notifications/push/subscriptions')
      .send(SUBSCRIPTION)
      .expect(201);
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .expect(200);
    expect(res.body.pushSubscriptionCount).toBe(1);
  });

  it('sends a test notification across the requested channels', async () => {
    webPush.sent.length = 0;
    email.sent.length = 0;
    const res = await request(app.getHttpServer())
      .post('/api/v1/notifications/test')
      .send({ channels: ['web_push', 'email'], title: 'Hello', body: 'World' })
      .expect(201);
    expect(res.body.outcome).toBe('sent');
    expect(webPush.sent).toHaveLength(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('user@example.com');
    const payload = JSON.parse(webPush.sent[0].payload);
    expect(payload).toMatchObject({ title: 'Hello', body: 'World' });
  });

  it('unregisters a web-push subscription', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/notifications/push/subscriptions')
      .send({ endpoint: SUBSCRIPTION.endpoint })
      .expect(204);
    const res = await request(app.getHttpServer())
      .get('/api/v1/notifications/preferences')
      .expect(200);
    expect(res.body.pushSubscriptionCount).toBe(0);
  });
});

import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). This spec runs WITH
// authentication enabled so it can assert the @Public() emergency-access route
// is reachable without a session while the owner routes still 401.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'false';
process.env.GEOCODER = 'stub';
process.env.PLAUD_POLL_INTERVAL_MS = '0';
process.env.CALENDAR_POLL_INTERVAL_MS = '0';
// Deterministic dead-man's-switch: no background sweep, and no grace window so
// a single manual sweep both arms and grants.
process.env.DEAD_MANS_SWITCH_SCHEDULER_ENABLED = 'false';
process.env.DEAD_MANS_SWITCH_GRACE_DAYS = '0';
process.env.PUBLIC_APP_URL = 'https://app.test';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { SESSION_COOKIE, SessionService } from '@plaudern/auth';
import { DeadMansSwitchReleaseService } from '@plaudern/audit';
import { EMAIL_SENDER, type EmailMessage } from '@plaudern/notifications';
import { DeadMansSwitchEntity, UserEntity } from '@plaudern/persistence';
import { createE2eApp } from '../testing/e2e-app';

const DAY_MS = 24 * 60 * 60 * 1000;
const CONTACT = 'trusted@example.com';

/** Fake SMTP sender: records the message so we can read the access token out. */
class FakeEmailSender {
  readonly sent: EmailMessage[] = [];
  isConfigured() {
    return true;
  }
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
}

/** Pull the raw emergency-access token out of the email the contact received. */
function tokenFromEmail(email: FakeEmailSender): string {
  const body = `${email.sent.at(-1)?.text ?? ''} ${email.sent.at(-1)?.html ?? ''}`;
  const match = body.match(/emergency-access\/([a-f0-9]+)/);
  if (!match) throw new Error(`no emergency-access token in email: ${body}`);
  return match[1];
}

describe('Dead-man’s-switch emergency access (e2e, Path A)', () => {
  let app: INestApplication;
  let sessions: SessionService;
  let dataSource: DataSource;
  let releases: DeadMansSwitchReleaseService;
  const email = new FakeEmailSender();

  async function createUserSession(username: string, id = randomUUID()) {
    await dataSource.getRepository(UserEntity).insert({
      id,
      username,
      webauthnUserId: randomUUID(),
    });
    const { token } = await sessions.createSession(id);
    return { userId: id, cookie: `${SESSION_COOKIE}=${token}` };
  }

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(EMAIL_SENDER).useValue(email),
    );
    sessions = app.get(SessionService);
    dataSource = app.get(DataSource);
    releases = app.get(DeadMansSwitchReleaseService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('grants, resolves, and revokes emergency access over HTTP', async () => {
    const owner = await createUserSession('dms-owner');
    const server = app.getHttpServer();

    // Owner arms the switch (authenticated).
    await request(server)
      .put('/api/v1/account/dead-mans-switch')
      .set('cookie', owner.cookie)
      .send({ enabled: true, contactEmail: CONTACT, checkInIntervalDays: 1 })
      .expect(200);

    // Force a lapse: last check-in 100 days ago (interval is 1 day).
    await dataSource
      .getRepository(DeadMansSwitchEntity)
      .update(
        { userId: owner.userId },
        { lastCheckInAt: new Date(Date.now() - 100 * DAY_MS).toISOString() },
      );

    // Fire the switch (grace 0 → arm + grant in one sweep); the contact is emailed.
    email.sent.length = 0;
    const granted = await releases.sweepUser(owner.userId);
    expect(granted).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe(CONTACT);
    const token = tokenFromEmail(email);

    // PUBLIC: the contact (no session) resolves their token to the owner's export.
    const access = await request(server)
      .get(`/api/v1/account/emergency-access/${token}`)
      .expect(200);
    expect(access.body).toMatchObject({ schemaVersion: 1, userId: owner.userId });
    expect(Array.isArray(access.body.items)).toBe(true);

    // PUBLIC: an unknown token is a 404, not a 200 with someone's data.
    await request(server)
      .get('/api/v1/account/emergency-access/deadbeefdeadbeefdeadbeefdeadbeef')
      .expect(404);

    // Owner lists the release and revokes it (authenticated).
    const list = await request(server)
      .get('/api/v1/account/dead-mans-switch/releases')
      .set('cookie', owner.cookie)
      .expect(200);
    expect(list.body.releases).toHaveLength(1);
    expect(list.body.releases[0].status).toBe('active');
    const releaseId = list.body.releases[0].id;

    const revoked = await request(server)
      .post(`/api/v1/account/dead-mans-switch/releases/${releaseId}/revoke`)
      .set('cookie', owner.cookie)
      .expect(201);
    expect(revoked.body.status).toBe('revoked');

    // PUBLIC: the revoked token no longer resolves.
    await request(server).get(`/api/v1/account/emergency-access/${token}`).expect(404);
  });

  it('walls the authenticated switch routes off without a session', async () => {
    const server = app.getHttpServer();
    await request(server).get('/api/v1/account/dead-mans-switch').expect(401);
    await request(server).get('/api/v1/account/dead-mans-switch/releases').expect(401);
    await request(server).post('/api/v1/account/dead-mans-switch/check-in').expect(401);
    await request(server)
      .post('/api/v1/account/dead-mans-switch/releases/00000000-0000-0000-0000-000000000000/revoke')
      .expect(401);
  });
});

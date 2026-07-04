import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). Unlike the other
// Path A specs this one runs WITH authentication enabled.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'false';
process.env.GEOCODER = 'stub';

import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { AuthService, SESSION_COOKIE, SessionService } from '@plaudern/auth';
import { DEFAULT_USER_ID, InboxItemEntity, UserEntity } from '@plaudern/persistence';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { createE2eApp } from '../testing/e2e-app';

describe('Authentication & multi-user isolation (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let sessions: SessionService;
  let dataSource: DataSource;

  /**
   * Creates a user + session directly (the WebAuthn ceremony itself needs a
   * real authenticator, so its crypto is @simplewebauthn's responsibility —
   * these tests cover everything around it: the guard, sessions, isolation).
   */
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
    app = await createE2eApp();

    storage = app.get(StorageService) as InMemoryStorageService;
    sessions = app.get(SessionService);
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('guard', () => {
    it('keeps /api/health public', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    });

    it('rejects every data route without a session', async () => {
      const server = app.getHttpServer();
      await request(server).get('/api/v1/inbox').expect(401);
      await request(server).post('/api/v1/ingest/init').send({}).expect(401);
      await request(server).get('/api/v1/speakers').expect(401);
      await request(server).get('/api/v1/calendar/feeds').expect(401);
      await request(server).get('/api/v1/settings/plaud').expect(401);
      await request(server).get('/api/v1/events').expect(401);
      await request(server).get('/api/v1/auth/passkeys').expect(401);
    });

    it('rejects a garbage session cookie', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/inbox')
        .set('cookie', `${SESSION_COOKIE}=not-a-real-token`)
        .expect(401);
    });
  });

  describe('passkey ceremonies (HTTP layer)', () => {
    it('reports status for the login screen', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/auth/status').expect(200);
      expect(res.body).toMatchObject({ allowRegistration: true, authDisabled: false });
    });

    it('hands out registration options with a challenge cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register/options')
        .send({ username: 'Alice' })
        .expect(201);
      expect(res.body.options.challenge).toEqual(expect.any(String));
      expect(res.body.options.rp.id).toBe('localhost');
      expect(res.body.options.user.name).toBe('alice'); // normalized
      expect(res.body.options.authenticatorSelection.residentKey).toBe('required');
      const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      expect(setCookie.join(';')).toContain('plaudern_challenge=');
    });

    it('hands out usernameless login options', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login/options')
        .expect(201);
      expect(res.body.options.challenge).toEqual(expect.any(String));
      expect(res.body.options.allowCredentials).toEqual([]);
    });

    it('rejects a verify without a pending challenge', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/verify')
        .send({ response: { id: 'x' } })
        .expect(400);
    });

    it('rejects an invalid username with 400', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register/options')
        .send({ username: 'a' })
        .expect(400);
    });
  });

  describe('sessions', () => {
    it('resolves /auth/me and survives logout', async () => {
      const alice = await createUserSession('alice-session');
      const me = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', alice.cookie)
        .expect(200);
      expect(me.body.user).toMatchObject({ id: alice.userId, username: 'alice-session' });

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('cookie', alice.cookie)
        .expect(204);
      await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('cookie', alice.cookie)
        .expect(401);
    });
  });

  describe('multi-user isolation', () => {
    it('walls every user off from the others completely', async () => {
      const alice = await createUserSession('alice');
      const bob = await createUserSession('bob');
      const server = app.getHttpServer();

      // Alice ingests an audio item end to end.
      const audio = Buffer.from('alice-private-audio');
      const init = await request(server)
        .post('/api/v1/ingest/init')
        .set('cookie', alice.cookie)
        .send({
          sourceType: 'audio',
          contentType: 'audio/mpeg',
          byteSize: audio.byteLength,
          occurredAt: '2026-07-01T09:30:00.000Z',
          idempotencyKey: 'iso-audio-1',
        })
        .expect(201);
      // Storage keys are namespaced per user.
      expect(init.body.storageKey).toContain(`inbox/${alice.userId}/`);
      await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
      await request(server)
        .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
        .set('cookie', alice.cookie)
        .expect(201);
      const itemId = init.body.inboxItemId;

      // Alice sees her item; Bob's inbox is empty.
      const aliceList = await request(server)
        .get('/api/v1/inbox')
        .set('cookie', alice.cookie)
        .expect(200);
      expect(aliceList.body.items).toHaveLength(1);
      const bobList = await request(server)
        .get('/api/v1/inbox')
        .set('cookie', bob.cookie)
        .expect(200);
      expect(bobList.body.items).toHaveLength(0);

      // Bob cannot read, delete, retry or resolve Alice's item — not even
      // knowing its id.
      await request(server).get(`/api/v1/inbox/${itemId}`).set('cookie', bob.cookie).expect(404);
      await request(server)
        .get(`/api/v1/inbox/${itemId}/source-url`)
        .set('cookie', bob.cookie)
        .expect(404);
      await request(server)
        .get(`/api/v1/inbox/${itemId}/speaker-transcript`)
        .set('cookie', bob.cookie)
        .expect(404);
      await request(server)
        .post(`/api/v1/inbox/${itemId}/transcription/retry`)
        .set('cookie', bob.cookie)
        .expect(404);
      await request(server).delete(`/api/v1/inbox/${itemId}`).set('cookie', bob.cookie).expect(404);
      // ...and it is still there for Alice.
      await request(server).get(`/api/v1/inbox/${itemId}`).set('cookie', alice.cookie).expect(200);

      // Diarization created voice profiles for Alice only.
      const aliceSpeakers = await request(server)
        .get('/api/v1/speakers')
        .set('cookie', alice.cookie)
        .expect(200);
      expect(aliceSpeakers.body.profiles.length).toBeGreaterThan(0);
      const bobSpeakers = await request(server)
        .get('/api/v1/speakers')
        .set('cookie', bob.cookie)
        .expect(200);
      expect(bobSpeakers.body.profiles).toHaveLength(0);
      // Bob cannot open Alice's profiles by id either.
      await request(server)
        .get(`/api/v1/speakers/${aliceSpeakers.body.profiles[0].id}`)
        .set('cookie', bob.cookie)
        .expect(404);

      // Bob's idempotency keys don't collide with Alice's.
      const bobInit = await request(server)
        .post('/api/v1/ingest/init')
        .set('cookie', bob.cookie)
        .send({
          sourceType: 'audio',
          contentType: 'audio/mpeg',
          byteSize: 4,
          occurredAt: '2026-07-01T09:30:00.000Z',
          idempotencyKey: 'iso-audio-1', // same key as Alice's item
        })
        .expect(201);
      expect(bobInit.body.inboxItemId).not.toBe(itemId);

      // Settings are per user.
      const bobSettings = await request(server)
        .get('/api/v1/settings/plaud')
        .set('cookie', bob.cookie)
        .expect(200);
      expect(bobSettings.body.configured).toBe(false);
    });

    it('adopts pre-auth data under a real random owner id (never the sentinel)', async () => {
      // Rows created while the instance ran unauthenticated belong to the
      // DEFAULT_USER_ID sentinel. The first real account gets its OWN random
      // id and adopts that data by re-pointing it — no account ever carries
      // the sentinel id itself.
      const legacyId = randomUUID();
      await dataSource.getRepository(InboxItemEntity).insert({
        id: legacyId,
        userId: DEFAULT_USER_ID,
        sourceType: 'text',
        occurredAt: '2026-07-01T08:00:00.000Z',
        idempotencyKey: 'pre-auth-legacy-1',
        metadata: null,
      });

      const owner = await createUserSession('first-owner'); // real random id
      expect(owner.userId).not.toBe(DEFAULT_USER_ID);
      const stranger = await createUserSession('stranger');

      // Before adoption the legacy row is still owned by the sentinel, so even
      // the fresh owner can't see it.
      await request(app.getHttpServer())
        .get(`/api/v1/inbox/${legacyId}`)
        .set('cookie', owner.cookie)
        .expect(404);

      await app.get(AuthService).adoptPreAuthData(owner.userId);

      // Now the owner sees the adopted row; a stranger never does.
      await request(app.getHttpServer())
        .get(`/api/v1/inbox/${legacyId}`)
        .set('cookie', owner.cookie)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/inbox/${legacyId}`)
        .set('cookie', stranger.cookie)
        .expect(404);
    });
  });
});

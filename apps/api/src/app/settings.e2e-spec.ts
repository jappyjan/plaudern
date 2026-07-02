import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init).
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.APP_ENCRYPTION_SECRET = 'test-secret';
process.env.PLAUD_POLL_INTERVAL_MS = '0'; // no background poller in tests

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PlaudApiClient, type PlaudRecording } from '@plaudern/plaud-sync';
import { TRANSCRIPTION_PROVIDER } from '@plaudern/transcription';
import { DIARIZATION_PROVIDER } from '@plaudern/speaker-id';
import {
  FakeDiarizationProvider,
  FakeTranscriptionProvider,
} from '../testing/fake-providers';
import { AppModule } from './app.module';

const RECORDINGS: PlaudRecording[] = [
  {
    id: 'rec-1',
    filename: 'standup.mp3',
    startTime: '2026-07-01T09:00:00.000Z',
    duration: 61000,
    fileSize: 20,
    serialNumber: 'SN42',
    isTrash: false,
  },
  {
    id: 'rec-trashed',
    filename: 'deleted.mp3',
    startTime: '2026-07-01T10:00:00.000Z',
    duration: 1000,
    fileSize: 20,
    serialNumber: 'SN42',
    isTrash: true,
  },
];

describe('Plaud settings + sync (e2e)', () => {
  let app: INestApplication;

  const fakeClient = {
    login: jest.fn().mockResolvedValue({
      accessToken: 'fake-jwt',
      expiresAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    getMe: jest.fn().mockResolvedValue(undefined),
    listRecordings: jest.fn().mockResolvedValue(RECORDINGS),
    downloadRecording: jest
      .fn()
      .mockResolvedValue({ body: Buffer.from('fake-plaud-audio'), contentType: 'audio/mpeg' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PlaudApiClient)
      .useValue(fakeClient)
      .overrideProvider(TRANSCRIPTION_PROVIDER)
      .useValue(new FakeTranscriptionProvider())
      .overrideProvider(DIARIZATION_PROVIDER)
      .useValue(new FakeDiarizationProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  /** The sync triggered by PUT/POST runs fire-and-forget — poll until it lands. */
  async function waitForSyncResult(previousSyncAt: string | null): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const res = await request(app.getHttpServer()).get('/api/v1/settings/plaud').expect(200);
      if (res.body.lastSyncAt && res.body.lastSyncAt !== previousSyncAt && !res.body.syncRunning) {
        return res.body;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('sync never finished');
  }

  it('starts unconfigured', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/settings/plaud').expect(200);
    expect(res.body).toMatchObject({
      configured: false,
      enabled: false,
      hasPassword: false,
      syncRunning: false,
    });
  });

  it('requires a password on first save', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings/plaud')
      .send({ email: 'me@example.com', region: 'eu', enabled: false })
      .expect(400);
  });

  it('stores credentials and never returns the password', async () => {
    const res = await request(app.getHttpServer())
      .put('/api/v1/settings/plaud')
      .send({ email: 'me@example.com', password: 'super-secret-pw', region: 'eu', enabled: false })
      .expect(200);

    expect(res.body).toMatchObject({
      configured: true,
      enabled: false,
      email: 'me@example.com',
      region: 'eu',
      hasPassword: true,
    });
    expect(JSON.stringify(res.body)).not.toContain('super-secret-pw');

    const get = await request(app.getHttpServer()).get('/api/v1/settings/plaud').expect(200);
    expect(JSON.stringify(get.body)).not.toContain('super-secret-pw');
  });

  it('tests the connection with stored credentials', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/settings/plaud/test')
      .send({})
      .expect(201);
    expect(res.body).toEqual({ ok: true, error: null });
    expect(fakeClient.login).toHaveBeenCalledWith('eu', 'me@example.com', 'super-secret-pw');
    expect(fakeClient.getMe).toHaveBeenCalled();
  });

  it('reports a failed connection instead of throwing', async () => {
    fakeClient.login.mockRejectedValueOnce(new Error('wrong region'));
    const res = await request(app.getHttpServer())
      .post('/api/v1/settings/plaud/test')
      .send({})
      .expect(201);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain('wrong region');
  });

  it('refuses a manual sync while disabled', async () => {
    await request(app.getHttpServer()).post('/api/v1/settings/plaud/sync').expect(400);
  });

  it('enabling sync imports Plaud recordings into the inbox end-to-end', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings/plaud')
      .send({ email: 'me@example.com', region: 'eu', enabled: true })
      .expect(200);

    const result = await waitForSyncResult(null);
    expect(result.lastSyncStatus).toBe('ok');
    expect(result.lastSyncImportedCount).toBe(1); // trashed recording skipped

    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    const plaudItems = inbox.body.items.filter(
      (item: { sourceType: string }) => item.sourceType === 'plaud',
    );
    expect(plaudItems).toHaveLength(1);
    const item = plaudItems[0];
    expect(item.occurredAt).toBe('2026-07-01T09:00:00.000Z');
    expect(item.source.uploadStatus).toBe('committed');
    expect(item.source.originalFilename).toBe('standup.mp3');
    expect(item.metadata).toMatchObject({
      plaudFileId: 'rec-1',
      serialNumber: 'SN42',
      importedVia: 'plaud-cloud-sync',
    });
    // audio-bearing source type -> transcription + diarization pipelines ran (inline+stub)
    expect(item.extractions).toHaveLength(2);
    const transcription = item.extractions.find(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(transcription.status).toBe('succeeded');
    const diarization = item.extractions.find((e: { kind: string }) => e.kind === 'diarization');
    expect(diarization.status).toBe('succeeded');
  });

  it('re-syncing is idempotent', async () => {
    const before = await request(app.getHttpServer()).get('/api/v1/settings/plaud').expect(200);

    const res = await request(app.getHttpServer())
      .post('/api/v1/settings/plaud/sync')
      .expect(201);
    expect(res.body.alreadyRunning).toBe(false);

    const result = await waitForSyncResult(before.body.lastSyncAt);
    expect(result.lastSyncStatus).toBe('ok');
    expect(result.lastSyncImportedCount).toBe(0);

    const inbox = await request(app.getHttpServer()).get('/api/v1/inbox?limit=10').expect(200);
    const plaudItems = inbox.body.items.filter(
      (item: { sourceType: string }) => item.sourceType === 'plaud',
    );
    expect(plaudItems).toHaveLength(1);
  });
});

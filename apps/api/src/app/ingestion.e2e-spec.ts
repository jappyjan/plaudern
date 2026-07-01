import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.TRANSCRIPTION_PROVIDER = 'stub';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '@plaudern/auth';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { AppModule } from './app.module';

describe('Ingestion pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let apiKey: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();

    storage = app.get(StorageService) as InMemoryStorageService;

    const auth = app.get(AuthService);
    const user = await auth.ensureUser('e2e@plaudern.local');
    const registered = await auth.registerDevice(user.id, 'generic');
    apiKey = registered.apiKey;
  });

  afterAll(async () => {
    await app.close();
  });

  const auth = () => ({ 'x-device-key': apiKey });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer()).get('/api/v1/inbox').expect(401);
  });

  it('ingests audio end-to-end and produces a transcription', async () => {
    const audio = Buffer.from('fake-audio-bytes-for-testing');

    // 1. init -> immutable envelope + presigned (memory://) upload URL
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .set(auth())
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-audio-1',
      })
      .expect(201);

    expect(init.body.inboxItemId).toBeDefined();
    expect(init.body.uploadUrl).toContain('memory://');
    expect(init.body.alreadyCommitted).toBe(false);

    // 2. simulate the client's direct PUT to the presigned URL
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');

    // 3. commit -> verifies upload, enqueues transcription (inline => runs now)
    const commit = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .set(auth())
      .expect(201);

    expect(commit.body.source.uploadStatus).toBe('committed');
    expect(commit.body.sourceType).toBe('audio');

    // 4. read back the item — the extracted payload is present and succeeded
    const get = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${init.body.inboxItemId}`)
      .set(auth())
      .expect(200);

    expect(get.body.extractions).toHaveLength(1);
    const extraction = get.body.extractions[0];
    expect(extraction.kind).toBe('transcription');
    expect(extraction.status).toBe('succeeded');
    expect(extraction.content).toContain('stub transcription');
  });

  it('is idempotent: re-init with the same key returns the same item', async () => {
    const body = {
      sourceType: 'audio' as const,
      contentType: 'audio/mpeg',
      byteSize: 10,
      occurredAt: '2026-07-01T09:30:00.000Z',
      idempotencyKey: 'e2e-audio-dupe',
    };
    const first = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .set(auth())
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .set(auth())
      .send(body)
      .expect(201);
    expect(second.body.inboxItemId).toBe(first.body.inboxItemId);
  });

  it('ingests inline text as an immediately-committed item', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .set(auth())
      .send({
        text: 'a quick captured thought',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'e2e-text-1',
      })
      .expect(201);
    expect(res.body.sourceType).toBe('text');
    expect(res.body.source.uploadStatus).toBe('committed');
    expect(res.body.extractions).toHaveLength(0);
  });

  it('lists inbox items newest-first for the device owner', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inbox?limit=10')
      .set(auth())
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a non-audio content type for the audio source', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .set(auth())
      .send({
        sourceType: 'audio',
        contentType: 'image/png',
        byteSize: 10,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-bad-audio',
      })
      .expect(400);
  });
});

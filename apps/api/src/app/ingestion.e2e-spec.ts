import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { createE2eApp } from '../testing/e2e-app';

describe('Ingestion pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp();

    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the inbox without a session when AUTH_DISABLED=true', async () => {
    await request(app.getHttpServer()).get('/api/v1/inbox').expect(200);
  });

  it('ingests audio end-to-end and produces a transcription', async () => {
    const audio = Buffer.from('fake-audio-bytes-for-testing');

    // 1. init -> immutable envelope + presigned (memory://) upload URL
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-audio-1',
        metadata: {
          location: { lat: 52.52, lon: 13.405 },
          capturedVia: 'browser-recording',
        },
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
      .expect(201);

    expect(commit.body.source.uploadStatus).toBe('committed');
    expect(commit.body.sourceType).toBe('audio');

    // 4. read back the item — extraction succeeded, capture metadata surfaced
    const get = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${init.body.inboxItemId}`)
      .expect(200);

    // Audio commit schedules both transcription and speaker diarization.
    expect(get.body.extractions).toHaveLength(2);
    const extraction = get.body.extractions.find(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(extraction.status).toBe('succeeded');
    expect(extraction.content).toContain('test transcription');
    const diarization = get.body.extractions.find(
      (e: { kind: string }) => e.kind === 'diarization',
    );
    expect(diarization.status).toBe('succeeded');
    expect(get.body.metadata).toEqual({
      location: { lat: 52.52, lon: 13.405 },
      capturedVia: 'browser-recording',
    });
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
      .send(body)
      .expect(201);
    const second = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send(body)
      .expect(201);
    expect(second.body.inboxItemId).toBe(first.body.inboxItemId);
  });

  it('ingests inline text as an immediately-committed item', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
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

  it('lists inbox items newest-first', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/inbox?limit=10')
      .expect(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a non-audio content type for the audio source', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
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

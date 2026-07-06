import 'reflect-metadata';
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { InboxItemDto } from '@plaudern/contracts';
import { TRANSCRIPTION_PROVIDER } from '@plaudern/transcription';
import { CLIP_EXTRACTOR, PyannoteAiClient } from '@plaudern/speaker-id';
import { startInfra, type Infra } from '../testing/containers';
import {
  FakeClipExtractor,
  FakePyannoteAiClient,
  FakeTranscriptionProvider,
} from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

/**
 * Full-stack integration test (plan §6). Unlike the fast Path A e2e (sqlite +
 * in-memory store + inline queue), this runs against REAL Postgres, MinIO, and
 * Redis in throwaway containers: it exercises the actual migrations, real
 * presigned S3 PUT/HEAD, and asynchronous BullMQ transcription end to end.
 */
jest.setTimeout(180_000);

describe('Ingestion pipeline (integration, real Postgres + MinIO + Redis)', () => {
  let infra: Infra;
  let app: INestApplication;

  beforeAll(async () => {
    infra = await startInfra();

    process.env.DATABASE_DRIVER = 'postgres';
    process.env.DATABASE_URL = infra.databaseUrl;
    process.env.DATABASE_SYNCHRONIZE = 'false'; // run the real migrations
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_ENDPOINT = infra.s3Endpoint;
    process.env.S3_BUCKET = infra.bucket;
    process.env.S3_ACCESS_KEY = infra.accessKey;
    process.env.S3_SECRET_KEY = infra.secretKey;
    process.env.S3_FORCE_PATH_STYLE = 'true';
    process.env.QUEUE_DRIVER = 'bull';
    process.env.REDIS_URL = infra.redisUrl;
    process.env.GEOCODER = 'stub';
    process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec

    // Diarization builds its pyannoteAI client per job via the static
    // `PyannoteAiClient.fromResolvedConfig` (not a DI provider anymore), so a
    // provider override no longer intercepts it — spy the factory instead
    // (mirrors testing/e2e-app.ts).
    jest
      .spyOn(PyannoteAiClient, 'fromResolvedConfig')
      .mockReturnValue(new FakePyannoteAiClient() as unknown as PyannoteAiClient);

    const moduleRef = await Test.createTestingModule({
      imports: [(await import('./app.module')).AppModule],
    })
      .overrideProvider(TRANSCRIPTION_PROVIDER)
      .useValue(new FakeTranscriptionProvider())
      .overrideProvider(CLIP_EXTRACTOR)
      .useValue(new FakeClipExtractor())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();

    // Diarization is DB-gated now; enable speaker_id for the test user so the
    // async diarization queue runs against the real speaker tables.
    await seedAiCapability(app, 'speaker_id');
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('runs the migrations and answers health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('serves the inbox without any authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/inbox').expect(200);
  });

  it('ingests audio through real presigned upload + async transcription', async () => {
    const audio = new Uint8Array(Buffer.from('integration-audio-bytes'));

    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'int-audio-1',
      })
      .expect(201);

    // Real client-side PUT to the presigned MinIO URL.
    const put = await fetch(init.body.uploadUrl, {
      method: 'PUT',
      body: audio,
      headers: { 'content-type': 'audio/mpeg' },
    });
    expect(put.status).toBeGreaterThanOrEqual(200);
    expect(put.status).toBeLessThan(300);

    const commit = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    expect(commit.body.source.uploadStatus).toBe('committed');
    expect(commit.body.source.byteSize).toBe(audio.byteLength);

    // BullMQ processes asynchronously — poll until the transcript lands.
    const item = await waitForExtraction(app, init.body.inboxItemId, 'transcription');
    const transcript = item.extractions.find((e) => e.kind === 'transcription');
    expect(transcript?.status).toBe('succeeded');
    expect(transcript?.content).toContain('test transcription');

    // Diarization runs on its own queue against the real speaker tables.
    const diarized = await waitForExtraction(app, init.body.inboxItemId, 'diarization');
    const diarization = diarized.extractions.find((e) => e.kind === 'diarization');
    expect(diarization?.status).toBe('succeeded');

    const transcriptView = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${init.body.inboxItemId}/speaker-transcript`)
      .expect(200);
    expect(transcriptView.body.mode).toBe('segmented');
    expect(transcriptView.body.speakers).toHaveLength(2);

    const speakers = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    expect(speakers.body.profiles.length).toBeGreaterThanOrEqual(2);
    // Retry appends a second attempt through the real BullMQ path (and proves
    // the geocode_cache migration ran, since the app booted with migrations).
    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${init.body.inboxItemId}/transcription/retry`)
      .expect(201);
    const retried = await waitForTranscriptionCount(app, init.body.inboxItemId, 2);
    const attempts = retried.extractions.filter((e) => e.kind === 'transcription');
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('succeeded');
  });

  it('persists an immutable text item across a real DB round-trip', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'integration text note',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'int-text-1',
      })
      .expect(201);
    expect(res.body.sourceType).toBe('text');

    const list = await request(app.getHttpServer())
      .get('/api/v1/inbox?limit=10')
      .expect(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  });
});

async function waitForTranscriptionCount(
  app: INestApplication,
  id: string,
  count: number,
  timeoutMs = 30_000,
): Promise<InboxItemDto> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`);
    const item = res.body as InboxItemDto;
    const done = item.extractions?.filter(
      (e) => e.kind === 'transcription' && (e.status === 'succeeded' || e.status === 'failed'),
    );
    if (done && done.length >= count) return item;
    if (Date.now() > deadline) throw new Error('timed out waiting for transcriptions');
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function waitForExtraction(
  app: INestApplication,
  id: string,
  kind: 'transcription' | 'diarization',
  timeoutMs = 30_000,
): Promise<InboxItemDto> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`);
    const item = res.body as InboxItemDto;
    const t = item.extractions?.find((e) => e.kind === kind);
    if (t && (t.status === 'succeeded' || t.status === 'failed')) return item;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${kind}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

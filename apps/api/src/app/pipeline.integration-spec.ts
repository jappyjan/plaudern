import 'reflect-metadata';
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthService } from '@plaudern/auth';
import type { InboxItemDto } from '@plaudern/contracts';
import { startInfra, type Infra } from '../testing/containers';

/**
 * Full-stack integration test (plan §6). Unlike the fast Path A e2e (sqlite +
 * in-memory store + inline queue), this runs against REAL Postgres, MinIO, and
 * Redis in throwaway containers: it exercises the actual migration, real
 * presigned S3 PUT/HEAD, and asynchronous BullMQ transcription end to end.
 */
jest.setTimeout(180_000);

describe('Ingestion pipeline (integration, real Postgres + MinIO + Redis)', () => {
  let infra: Infra;
  let app: INestApplication;
  let apiKey: string;

  beforeAll(async () => {
    infra = await startInfra();

    process.env.DATABASE_DRIVER = 'postgres';
    process.env.DATABASE_URL = infra.databaseUrl;
    process.env.DATABASE_SYNCHRONIZE = 'false'; // run the real migration
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_ENDPOINT = infra.s3Endpoint;
    process.env.S3_BUCKET = infra.bucket;
    process.env.S3_ACCESS_KEY = infra.accessKey;
    process.env.S3_SECRET_KEY = infra.secretKey;
    process.env.S3_FORCE_PATH_STYLE = 'true';
    process.env.QUEUE_DRIVER = 'bull';
    process.env.REDIS_URL = infra.redisUrl;
    process.env.TRANSCRIPTION_PROVIDER = 'stub';

    const moduleRef = await Test.createTestingModule({
      imports: [(await import('./app.module')).AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();

    const auth = app.get(AuthService);
    const user = await auth.ensureUser('integration@plaudern.local');
    apiKey = (await auth.registerDevice(user.id, 'generic')).apiKey;
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  const authHeader = () => ({ 'x-device-key': apiKey });

  it('runs the migration and answers health', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(200);
  });

  it('ingests audio through real presigned upload + async transcription', async () => {
    const audio = new Uint8Array(Buffer.from('integration-audio-bytes'));

    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .set(authHeader())
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
      .set(authHeader())
      .expect(201);
    expect(commit.body.source.uploadStatus).toBe('committed');
    expect(commit.body.source.byteSize).toBe(audio.byteLength);

    // BullMQ processes asynchronously — poll until the transcript lands.
    const item = await waitForTranscription(app, init.body.inboxItemId, authHeader());
    const transcript = item.extractions.find((e) => e.kind === 'transcription');
    expect(transcript?.status).toBe('succeeded');
    expect(transcript?.content).toContain('stub transcription');
  });

  it('persists an immutable text item across a real DB round-trip', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .set(authHeader())
      .send({
        text: 'integration text note',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'int-text-1',
      })
      .expect(201);
    expect(res.body.sourceType).toBe('text');

    const list = await request(app.getHttpServer())
      .get('/api/v1/inbox?limit=10')
      .set(authHeader())
      .expect(200);
    expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  });
});

async function waitForTranscription(
  app: INestApplication,
  id: string,
  headers: Record<string, string>,
  timeoutMs = 30_000,
): Promise<InboxItemDto> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`).set(headers);
    const item = res.body as InboxItemDto;
    const t = item.extractions?.find((e) => e.kind === 'transcription');
    if (t && (t.status === 'succeeded' || t.status === 'failed')) return item;
    if (Date.now() > deadline) throw new Error('timed out waiting for transcription');
    await new Promise((r) => setTimeout(r, 500));
  }
}

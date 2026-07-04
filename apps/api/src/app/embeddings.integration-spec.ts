import 'reflect-metadata';
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import type { InboxItemDto } from '@plaudern/contracts';
import { TRANSCRIPTION_PROVIDER } from '@plaudern/transcription';
import { CLIP_EXTRACTOR, PyannoteAiClient } from '@plaudern/speaker-id';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
import { startInfra, type Infra } from '../testing/containers';
import {
  FakeClipExtractor,
  FakeEmbeddingProvider,
  FakePyannoteAiClient,
  FakeTranscriptionProvider,
} from '../testing/fake-providers';

/**
 * Full-stack integration test for the embeddings extraction (ATT-659) against
 * REAL Postgres with the pgvector extension (the `pgvector/pgvector` image),
 * MinIO and Redis. Unlike the fast sqlite Path A e2e, this proves the things
 * only a real database can:
 *
 *   1. the `…015-CreateEmbeddingChunks` migration applies (extension + vector
 *      column + HNSW index) on a fresh database, and
 *   2. vectors round-trip through the real `vector` column and native cosine
 *      nearest-neighbour search (`<=>`) works — a chunk is its own NN.
 *
 * Summarization is left unconfigured, so embeddings run straight after
 * transcription (transcript-only) — no LLM needed here.
 */
jest.setTimeout(180_000);

describe('Embeddings pipeline (integration, real Postgres + pgvector)', () => {
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
    process.env.AUTH_DISABLED = 'true';
    process.env.SUMMARIZATION_API_KEY = ''; // summarization off — embed transcript only

    const moduleRef = await Test.createTestingModule({
      imports: [(await import('./app.module')).AppModule],
    })
      .overrideProvider(TRANSCRIPTION_PROVIDER)
      .useValue(new FakeTranscriptionProvider())
      .overrideProvider(PyannoteAiClient)
      .useValue(new FakePyannoteAiClient())
      .overrideProvider(CLIP_EXTRACTOR)
      .useValue(new FakeClipExtractor())
      .overrideProvider(EMBEDDING_PROVIDER)
      .useValue(new FakeEmbeddingProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await infra?.stop();
  });

  it('created the embedding_chunks table with a pgvector column', async () => {
    const ds = app.get(DataSource);
    const cols: Array<{ udt_name: string }> = await ds.query(
      `SELECT udt_name FROM information_schema.columns
       WHERE table_name = 'embedding_chunks' AND column_name = 'embedding'`,
    );
    expect(cols).toHaveLength(1);
    expect(cols[0].udt_name).toBe('vector');
  });

  it('embeds a recording and supports native cosine nearest-neighbour search', async () => {
    const audio = new Uint8Array(Buffer.from('integration-embedding-bytes'));
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'int-embed-1',
      })
      .expect(201);

    await fetch(init.body.uploadUrl, {
      method: 'PUT',
      body: audio,
      headers: { 'content-type': 'audio/mpeg' },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);

    const itemId = init.body.inboxItemId as string;
    await waitForEmbedding(app, itemId);

    const ds = app.get(DataSource);
    const rows: Array<{ id: string; source: string; startSeconds: number | null }> = await ds.query(
      `SELECT id, source, "startSeconds" FROM embedding_chunks WHERE "inboxItemId" = $1 ORDER BY "chunkIndex" ASC`,
      [itemId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'transcript')).toBe(true);
    expect(rows[0].startSeconds).toBe(0);

    // Probe with a chunk's own stored vector: it must be its own nearest
    // neighbour under cosine distance (~0), proving the real `vector` column and
    // the `<=>` operator work end to end.
    const probe: Array<{ embedding: string }> = await ds.query(
      `SELECT embedding::text AS embedding FROM embedding_chunks WHERE id = $1`,
      [rows[0].id],
    );
    const nearest: Array<{ id: string; distance: number }> = await ds.query(
      `SELECT id, (embedding <=> $1::vector) AS distance
       FROM embedding_chunks
       WHERE "inboxItemId" = $2
       ORDER BY distance ASC
       LIMIT 1`,
      [probe[0].embedding, itemId],
    );
    expect(nearest[0].id).toBe(rows[0].id);
    expect(Number(nearest[0].distance)).toBeCloseTo(0, 5);
  });
});

async function waitForEmbedding(
  app: INestApplication,
  id: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`);
    const item = res.body as InboxItemDto;
    const embedding = item.extractions?.find((e) => e.kind === 'embedding');
    if (embedding && (embedding.status === 'succeeded' || embedding.status === 'failed')) {
      if (embedding.status === 'failed') throw new Error('embedding failed');
      return;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for embedding');
    await new Promise((r) => setTimeout(r, 500));
  }
}

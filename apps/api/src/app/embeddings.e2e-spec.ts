import 'reflect-metadata';

// Hardware-free, infra-free verification (see plan §6 Path A). Must run before
// the modules load — ConfigModule reads process.env at init. The fake
// summarization provider below reports enabled=true, so the extraction DAG's
// summary[settled] edge makes embedding wait for the summary — each recording
// is embedded once, covering transcript + summary together.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import type { EmbeddingPayload, InboxItemDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { EmbeddingChunkEntity } from '@plaudern/persistence';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { createE2eApp } from '../testing/e2e-app';
import {
  FakeEmbeddingProvider,
  FakeSummarizationProvider,
  FAKE_EMBEDDING_DIMENSIONS,
} from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

describe('Embeddings pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let chunks: Repository<EmbeddingChunkEntity>;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(SUMMARIZATION_PROVIDER)
        .useValue(new FakeSummarizationProvider())
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue(new FakeEmbeddingProvider()),
    );

    // The embedding extractor waits for the summary (summary[settled]) and both
    // capabilities are DB-gated now — enable them for the test user.
    await seedAiCapability(app, 'summarization');
    await seedAiCapability(app, 'embeddings');

    storage = app.get(StorageService) as InMemoryStorageService;
    chunks = app.get(getRepositoryToken(EmbeddingChunkEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(idempotencyKey: string): Promise<string> {
    const audio = Buffer.from(`fake-audio-${idempotencyKey}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  /** Embeddings are produced on a floating promise after the summary settles. */
  async function waitForEmbedding(itemId: string): Promise<InboxItemDto['extractions'][number]> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inbox/${itemId}`)
        .expect(200);
      const item = res.body as InboxItemDto;
      const embedding = latest(item, 'embedding');
      if (embedding && (embedding.status === 'succeeded' || embedding.status === 'failed')) {
        return embedding;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('embedding did not settle in time');
  }

  it('embeds transcript + summary as an append-only extraction once both are ready', async () => {
    const itemId = await ingestAudio('e2e-embed-1');
    const embedding = await waitForEmbedding(itemId);

    expect(embedding.status).toBe('succeeded');
    expect(embedding.provider).toBe('fake-embedding');
    const payload = JSON.parse(embedding.content ?? '{}') as EmbeddingPayload;
    expect(payload.model).toBe('fake-embedding-model');
    expect(payload.dimensions).toBe(FAKE_EMBEDDING_DIMENSIONS);
    expect(payload.transcriptChunks).toBeGreaterThan(0);
    expect(payload.summaryChunks).toBeGreaterThan(0);
    expect(payload.chunkCount).toBe(payload.transcriptChunks + payload.summaryChunks);
  });

  it('persists chunks: transcript chunks keep audio timestamps, summary chunks do not', async () => {
    const itemId = await ingestAudio('e2e-embed-timestamps');
    await waitForEmbedding(itemId);

    const rows = await chunks.find({ where: { inboxItemId: itemId }, order: { chunkIndex: 'ASC' } });
    expect(rows.length).toBeGreaterThan(0);

    const transcriptRows = rows.filter((r) => r.source === 'transcript');
    const summaryRows = rows.filter((r) => r.source === 'summary');
    expect(transcriptRows.length).toBeGreaterThan(0);
    expect(summaryRows.length).toBeGreaterThan(0);

    // The fake transcription is two segments spanning 0-16s; small enough to
    // coalesce into a single timestamped chunk.
    for (const row of transcriptRows) {
      expect(row.startSeconds).not.toBeNull();
      expect(row.endSeconds).not.toBeNull();
      expect(row.endSeconds!).toBeGreaterThan(row.startSeconds!);
      expect(row.dimensions).toBe(FAKE_EMBEDDING_DIMENSIONS);
      expect(row.embedding).toHaveLength(FAKE_EMBEDDING_DIMENSIONS);
    }
    expect(transcriptRows[0].startSeconds).toBe(0);
    expect(transcriptRows[transcriptRows.length - 1].endSeconds).toBe(16);

    for (const row of summaryRows) {
      expect(row.startSeconds).toBeNull();
      expect(row.endSeconds).toBeNull();
    }
  });

  it('does not embed twice for the same transcription+summary generation', async () => {
    const itemId = await ingestAudio('e2e-embed-dedup');
    await waitForEmbedding(itemId);
    // Give any stray trigger a chance to fire again.
    await new Promise((r) => setTimeout(r, 120));

    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(200);
    const embeddings = (res.body as InboxItemDto).extractions.filter((e) => e.kind === 'embedding');
    expect(embeddings).toHaveLength(1);
  });

  it('deletes an item and its embedding chunks together', async () => {
    const itemId = await ingestAudio('e2e-embed-delete');
    await waitForEmbedding(itemId);
    expect(await chunks.count({ where: { inboxItemId: itemId } })).toBeGreaterThan(0);

    await request(app.getHttpServer()).delete(`/api/v1/inbox/${itemId}`).expect(204);
    expect(await chunks.count({ where: { inboxItemId: itemId } })).toBe(0);
  });

  it('embeds a text note via its passthrough transcription (chunks carry no timestamps)', async () => {
    const text = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'a plain note',
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-embed-text',
      })
      .expect(201);

    const embedding = await waitForEmbedding(text.body.id);
    expect(embedding.status).toBe('succeeded');
    const payload = JSON.parse(embedding.content ?? '{}') as EmbeddingPayload;
    expect(payload.transcriptChunks).toBeGreaterThan(0);

    // The passthrough transcription has no segments, so unlike audio there are
    // no timestamps to anchor the chunks to.
    const rows = await chunks.find({ where: { inboxItemId: text.body.id } });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows.filter((r) => r.source === 'transcript')) {
      expect(row.startSeconds).toBeNull();
      expect(row.endSeconds).toBeNull();
    }
  });
});

function latest(item: InboxItemDto, kind: string) {
  return item.extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

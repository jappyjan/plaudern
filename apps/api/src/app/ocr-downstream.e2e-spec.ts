import 'reflect-metadata';

// Hardware-free, infra-free verification (Path A). Must run before modules load.
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
import { InboxService } from '@plaudern/inbox';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { EmbeddingChunkEntity, EntityMentionEntity } from '@plaudern/persistence';
import { EMBEDDING_PROVIDER } from '@plaudern/embeddings';
import { ENTITY_EXTRACTION_PROVIDER } from '@plaudern/entities';
import type { InboxItemDto } from '@plaudern/contracts';
import { createE2eApp } from '../testing/e2e-app';
import { FakeEmbeddingProvider, FakeEntityProvider } from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

/**
 * JJ-83: a scanned document that only ever produced an `ocr` extraction — no
 * transcription of its own — must become entity-linked, embedded and
 * keyword-searchable exactly like transcribed audio. We drive the OCR result in
 * directly (as the OCR processor's completed row would look, but WITHOUT the
 * passthrough transcription) so the item is genuinely transcription-free, then
 * let the DAG cascade: sentinel classifies the OCR text → the external-LLM
 * entities/embedding extractors run on it.
 */
describe('OCR text feeds entities/embeddings/search (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;
  let chunks: Repository<EmbeddingChunkEntity>;
  let mentions: Repository<EntityMentionEntity>;

  const OCR_TEXT =
    'Rechnung von ACME GmbH. Ansprechpartner Wolfgang. Betrag 42 EUR. Faellig 2026-08-01.';

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue(new FakeEmbeddingProvider())
        .overrideProvider(ENTITY_EXTRACTION_PROVIDER)
        .useValue(new FakeEntityProvider()),
    );

    // Enable the two downstream capabilities; leave OCR + summarization OFF so
    // the item's ONLY extraction is the one we write by hand (no real OCR run,
    // no passthrough transcription, no summary settle to wait on).
    await seedAiCapability(app, 'entity_extraction');
    await seedAiCapability(app, 'embeddings');

    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
    chunks = app.get(getRepositoryToken(EmbeddingChunkEntity));
    mentions = app.get(getRepositoryToken(EntityMentionEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestImage(idempotencyKey: string): Promise<string> {
    const bytes = Buffer.from(`fake-scan-${idempotencyKey}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'image',
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, bytes, 'image/jpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  /** Write a succeeded OCR row exactly as the OCR processor would, minus the
   * passthrough transcription bridge — this is the "OCR-only" item. */
  async function recordOcr(itemId: string, text: string): Promise<void> {
    const ext = await inbox.addExtraction(itemId, 'ocr', 'test-ocr', 1);
    await inbox.completeExtraction(ext.id, {
      status: 'succeeded',
      content: text,
      language: 'de',
    });
  }

  async function waitFor<T>(fn: () => Promise<T | null>, label: string): Promise<T> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const value = await fn();
      if (value !== null) return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`${label} did not settle in time`);
  }

  it('produces entities from OCR text on a transcription-free document', async () => {
    const itemId = await ingestImage('e2e-ocr-entities');
    await recordOcr(itemId, OCR_TEXT);

    const rows = await waitFor(
      async () => {
        const found = await mentions.find({ where: { inboxItemId: itemId } });
        return found.length > 0 ? found : null;
      },
      'entities',
    );

    // The fake pulls capitalized tokens (ACME, GmbH, Wolfgang, …) out of the OCR
    // text — proof the entity extractor consumed the OCR content, not a transcript.
    expect(rows.length).toBeGreaterThan(0);
    const surfaceForms = rows.map((r) => r.surfaceForm);
    expect(surfaceForms).toContain('ACME');

    // The item never grew a transcription row — it is genuinely OCR-only.
    const item = (await inbox.getItemById(itemId))!;
    expect(item.extractions.some((e) => e.kind === 'transcription')).toBe(false);
    expect(item.extractions.some((e) => e.kind === 'entities' && e.status === 'succeeded')).toBe(
      true,
    );
  });

  it('produces embeddings from OCR text (timeless chunks, no transcript segments)', async () => {
    const itemId = await ingestImage('e2e-ocr-embeddings');
    await recordOcr(itemId, OCR_TEXT);

    const rows = await waitFor(
      async () => {
        const found = await chunks.find({ where: { inboxItemId: itemId } });
        return found.length > 0 ? found : null;
      },
      'embedding chunks',
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.source).toBe('transcript');
      expect(row.startSeconds).toBeNull();
      expect(row.endSeconds).toBeNull();
      expect(row.text).toContain('ACME');
    }
  });

  it('returns the OCR-only document from hybrid search', async () => {
    const itemId = await ingestImage('e2e-ocr-search');
    await recordOcr(itemId, OCR_TEXT);
    // Wait until at least the embedding chunks exist so both search legs have data.
    await waitFor(
      async () => {
        const found = await chunks.count({ where: { inboxItemId: itemId } });
        return found > 0 ? found : null;
      },
      'embedding chunks (search)',
    );

    const res = await request(app.getHttpServer())
      .post('/api/v1/search')
      .send({ query: 'ACME' })
      .expect(201);

    const ids = (res.body.results as Array<{ itemId: string }>).map((r) => r.itemId);
    expect(ids).toContain(itemId);
  });

  it('leaves an audio item behaving exactly as before (entities + timestamped embeddings)', async () => {
    // A normal audio item still flows through the transcription path unchanged.
    const audio = Buffer.from('fake-audio-e2e-ocr-control');
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-ocr-audio-control',
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    const itemId = init.body.inboxItemId as string;

    const rows = await waitFor(
      async () => {
        const found = await chunks.find({ where: { inboxItemId: itemId } });
        return found.length > 0 ? found : null;
      },
      'audio embedding chunks',
    );

    // Audio keeps its transcription and timestamped transcript chunks.
    const item = (await inbox.getItemById(itemId))!;
    expect(item.extractions.some((e) => e.kind === 'transcription' && e.status === 'succeeded')).toBe(
      true,
    );
    const transcriptRows = rows.filter((r) => r.source === 'transcript');
    expect(transcriptRows.length).toBeGreaterThan(0);
    expect(transcriptRows.some((r) => r.startSeconds !== null)).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    expect((detail.body as InboxItemDto).extractions.some((e) => e.kind === 'entities')).toBe(true);
  });
});

import 'reflect-metadata';

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
import { OCR_PROVIDER, OcrService, type OcrProvider } from '@plaudern/ocr';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import {
  TOPIC_CLASSIFICATION_PROVIDER,
  type TopicClassificationProvider,
} from '@plaudern/topics';
import { createE2eApp } from '../testing/e2e-app';
import {
  FakeEmbeddingProvider,
  FakeEntityProvider,
  FakeSummarizationProvider,
} from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

describe('OCR is the single document source-text generation (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;
  let ocr: OcrService;
  let chunks: Repository<EmbeddingChunkEntity>;
  let mentions: Repository<EntityMentionEntity>;

  const OCR_TEXT =
    'Rechnung von ACME GmbH. Ansprechpartner Wolfgang. Betrag 42 EUR. Faellig 2026-08-01.';
  const recognize = jest.fn(async () => ({ text: OCR_TEXT, language: 'de' }));
  const summarize = jest.spyOn(new FakeSummarizationProvider(), 'summarize');
  const classify = jest.fn(async () => ({ assignments: [], model: 'fake-topic' }));

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(OCR_PROVIDER)
        .useValue({ id: 'fake-ocr', recognize } satisfies OcrProvider)
        .overrideProvider(SUMMARIZATION_PROVIDER)
        .useValue({ id: 'fake-summarization', summarize })
        .overrideProvider(EMBEDDING_PROVIDER)
        .useValue(new FakeEmbeddingProvider())
        .overrideProvider(ENTITY_EXTRACTION_PROVIDER)
        .useValue(new FakeEntityProvider())
        .overrideProvider(TOPIC_CLASSIFICATION_PROVIDER)
        .useValue({ id: 'fake-topic', classify } satisfies TopicClassificationProvider),
    );

    for (const capability of [
      'ocr',
      'summarization',
      'entity_extraction',
      'embeddings',
      'topics',
    ] as const) {
      await seedAiCapability(app, capability);
    }

    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
    ocr = app.get(OcrService);
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

  async function waitForRows(itemId: string, kinds: string[]): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
      const item = await inbox.getItemById(itemId);
      if (
        item &&
        kinds.every((kind) =>
          item.extractions.some((row) => row.kind === kind && row.status === 'succeeded'),
        )
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`extractions [${kinds.join(', ')}] did not settle in time`);
  }

  it('runs each downstream consumer once from the real OCR completion without transcription', async () => {
    const itemId = await ingestImage('e2e-real-ocr');
    await waitForRows(itemId, ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics']);

    const item = (await inbox.getItemById(itemId))!;
    expect(item.extractions.filter((row) => row.kind === 'transcription')).toHaveLength(0);
    for (const kind of ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics'] as const) {
      expect(item.extractions.filter((row) => row.kind === kind)).toHaveLength(1);
    }
    expect(recognize).toHaveBeenCalledTimes(1);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0][1]).toMatchObject({
      transcript: OCR_TEXT,
      language: 'de',
      sourceKind: 'note',
      speakers: [],
    });
    // An empty taxonomy short-circuits before the provider, but the topics
    // extraction still succeeds once for this source generation.

    const entityRows = await mentions.find({ where: { inboxItemId: itemId } });
    expect(entityRows.map((row) => row.surfaceForm)).toContain('ACME');
    const embeddingRows = await chunks.find({ where: { inboxItemId: itemId } });
    expect(embeddingRows.some((row) => row.text.includes('ACME'))).toBe(true);
    expect(embeddingRows.every((row) => row.startSeconds === null)).toBe(true);

    const search = await request(app.getHttpServer())
      .post('/api/v1/search')
      .send({ query: 'ACME' })
      .expect(201);
    expect(search.body.results.map((row: { itemId: string }) => row.itemId)).toContain(itemId);
  });

  it('creates one new downstream attempt for an OCR retry generation', async () => {
    const itemId = await ingestImage('e2e-ocr-retry');
    await waitForRows(itemId, ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics']);

    await ocr.retry('00000000-0000-0000-0000-000000000001', itemId);
    for (let attempt = 0; attempt < 150; attempt++) {
      const item = (await inbox.getItemById(itemId))!;
      if (
        ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics'].every(
          (kind) => item.extractions.filter((row) => row.kind === kind).length === 2,
        )
      ) {
        for (const kind of ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics']) {
          const generations = item.extractions
            .filter((row) => row.kind === kind)
            .map((row) => row.generation)
            .sort((a, b) => a - b);
          expect(generations[1]).toBeGreaterThan(generations[0]);
        }
        const allGenerations = item.extractions.map((row) => row.generation);
        expect(new Set(allGenerations).size).toBe(allGenerations.length);
        expect(item.extractionGeneration).toBe(allGenerations.length);
        expect(item.extractions.filter((row) => row.kind === 'transcription')).toHaveLength(0);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('OCR retry generation did not produce exactly one downstream attempt');
  });

  it('does not enqueue text consumers for blank OCR', async () => {
    recognize.mockResolvedValueOnce({ text: '  \n', language: 'de' });
    const itemId = await ingestImage('e2e-blank-ocr');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const item = (await inbox.getItemById(itemId))!;
    expect(item.extractions.filter((row) => row.kind === 'ocr')).toHaveLength(1);
    expect(item.extractions.filter((row) => row.kind === 'transcription')).toHaveLength(0);
    for (const kind of ['sentinel', 'summary', 'entities', 'embedding', 'topics']) {
      expect(item.extractions.filter((row) => row.kind === kind)).toHaveLength(0);
    }
  });

  it('blocks a blank OCR replacement without reusing or duplicating the previous generation', async () => {
    const itemId = await ingestImage('e2e-blank-ocr-replacement');
    await waitForRows(itemId, ['ocr', 'sentinel', 'summary', 'entities', 'embedding', 'topics']);

    recognize.mockResolvedValueOnce({ text: '  \n', language: 'de' });
    await ocr.retry('00000000-0000-0000-0000-000000000001', itemId);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const item = (await inbox.getItemById(itemId))!;
    expect(item.extractions.filter((row) => row.kind === 'ocr')).toHaveLength(2);
    expect(item.extractions.filter((row) => row.kind === 'transcription')).toHaveLength(0);
    for (const kind of ['sentinel', 'summary', 'entities', 'embedding', 'topics']) {
      expect(item.extractions.filter((row) => row.kind === kind)).toHaveLength(1);
    }
  });
});

import 'reflect-metadata';

// Hardware-free, infra-free verification (see plan §6 Path A). Must run before
// the modules load — ConfigModule reads process.env at init.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { SummaryDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { createE2eApp } from '../testing/e2e-app';
import { FakeSummarizationProvider } from '../testing/fake-providers';

describe('AI summarization pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(SUMMARIZATION_PROVIDER)
        .useValue(new FakeSummarizationProvider()),
    );

    storage = app.get(StorageService) as InMemoryStorageService;
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

  /** The summary is produced on a floating promise after diarization completes. */
  async function waitForSummary(itemId: string): Promise<SummaryDto> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inbox/${itemId}/summary`)
        .expect(200);
      const summary = res.body as SummaryDto;
      if (summary.status === 'succeeded' || summary.status === 'failed') return summary;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('summary did not settle in time');
  }

  it('summarizes an item once it is transcribed and diarized, with a title, layout and speaker mentions', async () => {
    const itemId = await ingestAudio('e2e-summary-1');
    const summary = await waitForSummary(itemId);

    expect(summary.status).toBe('succeeded');
    expect(summary.title).toBe('Test summary title');
    expect(summary.layout).toBe('meeting');
    expect(summary.model).toBe('fake-model');
    expect(summary.markdown).toContain('```mermaid');
    expect(summary.offTopic).toContain('Off-topic aside');

    // Both diarized speakers are in the roster and mentioned by label so the UI
    // can turn them into clickable chips.
    expect(summary.speakers.map((s) => s.label).sort()).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    for (const speaker of summary.speakers) {
      expect(summary.markdown).toContain(`@[${speaker.label}]`);
      expect(speaker.profileId).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it('exposes the summary as an append-only extraction on the item', async () => {
    const itemId = await ingestAudio('e2e-summary-2');
    await waitForSummary(itemId);

    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    const summaries = item.body.extractions.filter(
      (e: { kind: string }) => e.kind === 'summary',
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('succeeded');
  });

  it('does not summarize twice for the same transcription+diarization generation', async () => {
    const itemId = await ingestAudio('e2e-summary-dedup');
    await waitForSummary(itemId);
    // Give any stray trigger a chance to fire a second time.
    await new Promise((r) => setTimeout(r, 100));

    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    const summaries = item.body.extractions.filter(
      (e: { kind: string }) => e.kind === 'summary',
    );
    expect(summaries).toHaveLength(1);
  });

  it('manually regenerates a summary via the retry endpoint (append-only)', async () => {
    const itemId = await ingestAudio('e2e-summary-retry');
    await waitForSummary(itemId);

    const retried = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/summary/retry`)
      .expect(201);
    expect((retried.body as SummaryDto).status).not.toBeNull();

    // Poll until the fresh summary settles, then assert history grew.
    await waitForSummary(itemId);
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    const summaries = item.body.extractions.filter(
      (e: { kind: string }) => e.kind === 'summary',
    );
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it('defaults the summary language setting to auto and applies it to summaries', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/settings/summarization')
      .expect(200);
    expect(res.body).toEqual({ language: 'auto' });

    const itemId = await ingestAudio('e2e-summary-lang-auto');
    const summary = await waitForSummary(itemId);
    expect(summary.markdown).toContain('Language: auto.');
  });

  it('forces the summary into the user-selected language on the next summary', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings/summarization')
      .send({ language: 'de' })
      .expect(200)
      .expect((r) => expect(r.body).toEqual({ language: 'de' }));

    const itemId = await ingestAudio('e2e-summary-lang-de');
    const summary = await waitForSummary(itemId);
    // FakeSummarizationProvider echoes the English name of the forced language.
    expect(summary.markdown).toContain('Language: German.');

    // Reset so ordering never leaks the preference into other tests.
    await request(app.getHttpServer())
      .put('/api/v1/settings/summarization')
      .send({ language: 'auto' })
      .expect(200);
  });

  it('rejects an unknown language value', async () => {
    await request(app.getHttpServer())
      .put('/api/v1/settings/summarization')
      .send({ language: 'klingon' })
      .expect(400);
  });

  it('returns an empty summary (status null) for an item that has none', async () => {
    // A text item is never transcribed, so it never gets summarized.
    const text = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'a plain note',
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-summary-text',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${text.body.id}/summary`)
      .expect(200);
    const summary = res.body as SummaryDto;
    expect(summary.status).toBeNull();
    expect(summary.markdown).toBeNull();
    expect(summary.offTopic).toBeNull();
  });
});

import 'reflect-metadata';

// Hardware-free, infra-free verification (Path A). Must run before modules load.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { CorrectionNoteMutationResponse, SummaryDto } from '@plaudern/contracts';
import { TranscriptionService } from '@plaudern/transcription';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { createE2eApp } from '../testing/e2e-app';
import { FakeSummarizationProvider } from '../testing/fake-providers';
import { seedAiCapability } from '../testing/seed-ai-config';

/**
 * User correction notes (document-correction-notes): free-text remarks on an
 * inbox item that are fed into summary regeneration as authoritative
 * corrections — for every source type (audio transcript, typed text, scanned
 * documents via the OCR→transcription bridge) — while the source blob and its
 * transcription rows stay untouched.
 */
describe('Correction notes feed summary reprocessing (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let transcription: TranscriptionService;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(SUMMARIZATION_PROVIDER)
        .useValue(new FakeSummarizationProvider()),
    );
    await seedAiCapability(app, 'summarization');
    storage = app.get(StorageService) as InMemoryStorageService;
    transcription = app.get(TranscriptionService);
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

  async function ingestText(idempotencyKey: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'Lunch with Maier on Friday.',
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey,
      })
      .expect(201);
    return res.body.id;
  }

  /**
   * A scanned document: OCR itself is disabled in this suite, so replay the
   * OCR processor's passthrough transcription bridge by hand — the exact row a
   * real OCR run appends, and what summarization consumes for documents.
   */
  async function ingestDocument(idempotencyKey: string): Promise<string> {
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
    await transcription.recordExtractedText(init.body.inboxItemId, {
      content: 'Rechnung ACME GmbH, Betrag 42 EUR.',
      language: 'de',
    });
    return init.body.inboxItemId;
  }

  /** The summary is produced on a floating promise; poll until it settles. */
  async function waitForSummary(itemId: string): Promise<SummaryDto> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inbox/${itemId}/summary`)
        .expect(200);
      const summary = res.body as SummaryDto;
      if (summary.status === 'succeeded' || summary.status === 'failed') return summary;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('summary did not settle in time');
  }

  async function summaryRows(itemId: string) {
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    return item.body.extractions.filter((e: { kind: string }) => e.kind === 'summary');
  }

  it('adding a note queues an append-only summary regeneration that applies the correction', async () => {
    const itemId = await ingestAudio('e2e-notes-audio');
    const before = await waitForSummary(itemId);
    expect(before.status).toBe('succeeded');
    expect(before.markdown).not.toContain('Corrections:');

    const added = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: "The name is 'Meier', not 'Maier'." })
      .expect(201);
    const mutation = added.body as CorrectionNoteMutationResponse;
    expect(mutation.summaryQueued).toBe(true);
    expect(mutation.notes).toHaveLength(1);
    expect(mutation.notes[0].body).toBe("The name is 'Meier', not 'Maier'.");

    const after = await waitForSummary(itemId);
    expect(after.status).toBe('succeeded');
    // The fake provider echoes the notes it received, proving they reached the
    // summarization input on regeneration.
    expect(after.markdown).toContain("Corrections: The name is 'Meier', not 'Maier'.");

    // Append-only: the old summary stays in history; nothing was edited.
    expect((await summaryRows(itemId)).length).toBeGreaterThanOrEqual(2);
  });

  it('never touches the source: transcription rows are unchanged by note churn', async () => {
    const itemId = await ingestAudio('e2e-notes-immutable');
    await waitForSummary(itemId);

    const rowsBefore = (
      await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(200)
    ).body.extractions.filter((e: { kind: string }) => e.kind === 'transcription');

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: 'a correction' })
      .expect(201);
    await waitForSummary(itemId);

    const rowsAfter = (
      await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(200)
    ).body.extractions.filter((e: { kind: string }) => e.kind === 'transcription');
    expect(rowsAfter).toEqual(rowsBefore);
  });

  it('applies multiple notes in creation order and lists them', async () => {
    const itemId = await ingestText('e2e-notes-text');
    await waitForSummary(itemId);

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: 'first note' })
      .expect(201);
    await waitForSummary(itemId);
    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: 'second note' })
      .expect(201);

    const list = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}/notes`)
      .expect(200);
    expect(list.body.notes.map((n: { body: string }) => n.body)).toEqual([
      'first note',
      'second note',
    ]);

    const summary = await waitForSummary(itemId);
    expect(summary.markdown).toContain('Corrections: first note | second note.');
  });

  it('deleting a note regenerates the summary without it', async () => {
    const itemId = await ingestText('e2e-notes-delete');
    await waitForSummary(itemId);

    const added = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: 'temporary correction' })
      .expect(201);
    await waitForSummary(itemId);

    const removed = await request(app.getHttpServer())
      .delete(`/api/v1/inbox/${itemId}/notes/${added.body.notes[0].id}`)
      .expect(200);
    const mutation = removed.body as CorrectionNoteMutationResponse;
    expect(mutation.notes).toHaveLength(0);
    expect(mutation.summaryQueued).toBe(true);

    const summary = await waitForSummary(itemId);
    expect(summary.status).toBe('succeeded');
    expect(summary.markdown).not.toContain('Corrections:');
  });

  it('corrects a scanned document via its OCR→transcription bridge', async () => {
    const itemId = await ingestDocument('e2e-notes-document');
    await waitForSummary(itemId);

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: 'The amount is 24 EUR, the scan is misprinted.' })
      .expect(201);

    const summary = await waitForSummary(itemId);
    expect(summary.status).toBe('succeeded');
    expect(summary.markdown).toContain(
      'Corrections: The amount is 24 EUR, the scan is misprinted.',
    );
  });

  it('saves a note without regenerating when there is nothing to summarize yet', async () => {
    // A pending (never committed) upload has no transcription at all.
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: 10,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-notes-pending',
      })
      .expect(201);

    const added = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${init.body.inboxItemId}/notes`)
      .send({ body: 'early note' })
      .expect(201);
    const mutation = added.body as CorrectionNoteMutationResponse;
    expect(mutation.summaryQueued).toBe(false);
    expect(mutation.notes).toHaveLength(1);
  });

  it('rejects empty notes and unknown items/notes', async () => {
    const itemId = await ingestText('e2e-notes-validation');
    await waitForSummary(itemId);

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/notes`)
      .send({ body: '   ' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/inbox/00000000-0000-4000-8000-000000000000/notes')
      .send({ body: 'note' })
      .expect(404);
    await request(app.getHttpServer())
      .delete(`/api/v1/inbox/${itemId}/notes/00000000-0000-4000-8000-000000000000`)
      .expect(404);
  });
});

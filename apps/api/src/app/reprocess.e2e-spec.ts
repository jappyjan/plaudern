import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { InboxService } from '@plaudern/inbox';
import { ExtractedPayloadEntity } from '@plaudern/persistence';
import { createE2eApp } from '../testing/e2e-app';

describe('Reprocess whole pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;
  let extractionRepo: Repository<ExtractedPayloadEntity>;

  beforeAll(async () => {
    app = await createE2eApp();

    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
    extractionRepo = app.get(getRepositoryToken(ExtractedPayloadEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(idempotencyKey: string): Promise<string> {
    const audio = Buffer.from('fake-audio-bytes-for-reprocess');
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

  type Extraction = { id: string; kind: string; status: string };
  const byKind = (extractions: Extraction[], kind: string) =>
    extractions.filter((e) => e.kind === kind);

  it('re-runs both transcription and diarization (append-only history)', async () => {
    const itemId = await ingestAudio('e2e-reprocess-1');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${itemId}/reprocess`)
      .expect(201);

    // The first pass (on commit) produced one of each; reprocess appends a second.
    expect(byKind(res.body.extractions, 'transcription')).toHaveLength(2);
    expect(byKind(res.body.extractions, 'diarization')).toHaveLength(2);
    expect(byKind(res.body.extractions, 'transcription')[0].status).toBe('succeeded');
    expect(byKind(res.body.extractions, 'diarization')[0].status).toBe('succeeded');
  });

  it('reprocesses even when only diarization had failed (the OOM case)', async () => {
    const itemId = await ingestAudio('e2e-reprocess-diar-failed');
    const before = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    const diar = byKind(before.body.extractions, 'diarization')[0];
    await inbox.completeExtraction(diar.id, { status: 'failed', error: 'oom-killed' });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${itemId}/reprocess`)
      .expect(201);

    expect(byKind(res.body.extractions, 'diarization')[0].status).toBe('succeeded');
  });

  it('rejects reprocess while an extraction is still in flight', async () => {
    const itemId = await ingestAudio('e2e-reprocess-conflict');
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    await inbox.setExtractionStatus(item.body.extractions[0].id, 'processing');

    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${itemId}/reprocess`)
      .expect(409);
  });

  it('reclaims a stale in-flight extraction orphaned by a crashed worker', async () => {
    const itemId = await ingestAudio('e2e-reprocess-stale');
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);

    // Simulate a diarization row stranded in `processing` (e.g. BullMQ
    // force-failed a stalled job on redeploy without running our processor):
    // stuck status + a createdAt well past the staleness window.
    const diar = byKind(item.body.extractions, 'diarization')[0];
    await inbox.setExtractionStatus(diar.id, 'processing');
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await extractionRepo.update({ id: diar.id }, { createdAt: stale });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${itemId}/reprocess`)
      .expect(201);

    // The stranded row is reclaimed as failed; a fresh pass is appended and
    // both kinds succeed again.
    const diarizations = byKind(res.body.extractions, 'diarization');
    expect(diarizations[0].status).toBe('succeeded');
    const reclaimed = diarizations.find((e: Extraction) => e.id === diar.id) as
      | (Extraction & { error: string | null })
      | undefined;
    expect(reclaimed?.status).toBe('failed');
    expect(reclaimed?.error).toContain('superseded by reprocess');
  });

  it('404s for an unknown item', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/00000000-0000-0000-0000-00000000dead/reprocess')
      .expect(404);
  });

  it('re-runs transcription only via the per-step endpoint (append-only)', async () => {
    const itemId = await ingestAudio('e2e-retry-transcription');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/transcription/retry`)
      .expect(201);

    expect(byKind(res.body.extractions, 'transcription')).toHaveLength(2);
    // Diarization is untouched by a transcription-only retry.
    expect(byKind(res.body.extractions, 'diarization')).toHaveLength(1);
    expect(byKind(res.body.extractions, 'transcription')[0].status).toBe('succeeded');
  });

  it('re-runs speaker identification only via the per-step endpoint (append-only)', async () => {
    const itemId = await ingestAudio('e2e-retry-diarization');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/diarization/retry`)
      .expect(201);

    expect(byKind(res.body.extractions, 'diarization')).toHaveLength(2);
    // Transcription is untouched by a diarization-only retry.
    expect(byKind(res.body.extractions, 'transcription')).toHaveLength(1);
    expect(byKind(res.body.extractions, 'diarization')[0].status).toBe('succeeded');
  });

  it('rejects a diarization retry while one is already in progress', async () => {
    const itemId = await ingestAudio('e2e-retry-diarization-conflict');
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    const diar = byKind(item.body.extractions, 'diarization')[0];
    await inbox.setExtractionStatus(diar.id, 'processing');

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/diarization/retry`)
      .expect(409);
  });

  it('404s a per-step retry for an unknown item', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/inbox/00000000-0000-0000-0000-00000000dead/diarization/retry')
      .expect(404);
  });
});

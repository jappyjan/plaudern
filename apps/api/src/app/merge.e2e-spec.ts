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
import type { ExtractedPayloadDto, InboxItemDto, SummaryDto } from '@plaudern/contracts';
import { ExtractedPayloadEntity, RecordingMergeEntity } from '@plaudern/persistence';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { SUMMARIZATION_PROVIDER } from '@plaudern/summarization';
import { createE2eApp } from '../testing/e2e-app';
import { FakeSummarizationProvider } from '../testing/fake-providers';

describe('Merge & split recordings (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let extractionRepo: Repository<ExtractedPayloadEntity>;
  let mergeRepo: Repository<RecordingMergeEntity>;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(SUMMARIZATION_PROVIDER).useValue(new FakeSummarizationProvider()),
    );
    storage = app.get(StorageService) as InMemoryStorageService;
    extractionRepo = app.get(getRepositoryToken(ExtractedPayloadEntity));
    mergeRepo = app.get(getRepositoryToken(RecordingMergeEntity));
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(idempotencyKey: string, occurredAt: string): Promise<InboxItemDto> {
    const audio = Buffer.from(`fake-audio-${idempotencyKey}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt,
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    const committed = await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return committed.body as InboxItemDto;
  }

  function latestOfKind(item: InboxItemDto, kind: string): ExtractedPayloadDto | undefined {
    // toInboxItemDto sorts extractions newest-first.
    return item.extractions.find((e) => e.kind === kind);
  }

  /** The summary lands on a floating promise after the stitched rows complete. */
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

  async function listItemIds(): Promise<string[]> {
    const res = await request(app.getHttpServer()).get('/api/v1/inbox?limit=100').expect(200);
    return res.body.items.map((item: InboxItemDto) => item.id);
  }

  it('merges recordings chronologically, stitching transcription and diarization instead of re-running them', async () => {
    const a = await ingestAudio('merge-happy-a', '2026-07-01T09:00:00.000Z');
    const b = await ingestAudio('merge-happy-b', '2026-07-01T10:00:00.000Z');

    // Request order is B-first; playback order must still be chronological.
    const res = await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [b.id, a.id] })
      .expect(201);
    const merged = res.body as InboxItemDto;

    expect(merged.mergedFromItemIds).toEqual([a.id, b.id]);
    expect(merged.occurredAt).toBe('2026-07-01T09:00:00.000Z');
    expect(merged.sourceType).toBe('audio');
    expect((merged.metadata?.tags as { durationSeconds: number }).durationSeconds).toBe(32);

    // Transcription was stitched (provider 'merged'), not re-run: contents
    // joined, segments shifted by the first part's 16s duration.
    const transcription = latestOfKind(merged, 'transcription')!;
    expect(transcription.provider).toBe('merged');
    expect(transcription.status).toBe('succeeded');
    expect(transcription.content).toBe(
      '[test transcription, audio/mpeg]\n\n[test transcription, audio/mpeg]',
    );
    expect(transcription.segments?.map((s) => [s.start, s.end])).toEqual([
      [0, 8],
      [8, 16],
      [16, 24],
      [24, 32],
    ]);

    // Diarization was stitched too. The constant voice (0–8s of every fake
    // recording, same voice profile) collapses onto ONE merged label; each
    // per-recording voice gets its own.
    const diarization = latestOfKind(merged, 'diarization')!;
    expect(diarization.provider).toBe('merged');
    expect(diarization.status).toBe('succeeded');
    expect(diarization.segments).toEqual([
      { start: 0, end: 8, speaker: 'SPEAKER_00' },
      { start: 8, end: 16, speaker: 'SPEAKER_01' },
      { start: 16, end: 24, speaker: 'SPEAKER_00' },
      { start: 24, end: 32, speaker: 'SPEAKER_02' },
    ]);

    // The speaker transcript resolves the merged labels to voice profiles —
    // three distinct speakers, and the constant voice spans both halves.
    const transcript = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${merged.id}/speaker-transcript`)
      .expect(200);
    expect(transcript.body.mode).toBe('segmented');
    expect(transcript.body.speakers).toHaveLength(3);
    const profileIds = new Set(transcript.body.speakers.map((s: { profileId: string }) => s.profileId));
    expect(profileIds.size).toBe(3);

    // The downstream pipeline stage (summary + title) re-ran automatically.
    const summary = await waitForSummary(merged.id);
    expect(summary.status).toBe('succeeded');
    expect(summary.title).toBe('Test summary title');
  });

  it('hides merged sources from the list but keeps them fetchable by id', async () => {
    const a = await ingestAudio('merge-hide-a', '2026-07-02T09:00:00.000Z');
    const b = await ingestAudio('merge-hide-b', '2026-07-02T10:00:00.000Z');
    const merged = (
      await request(app.getHttpServer())
        .post('/api/v1/inbox/merge')
        .send({ itemIds: [a.id, b.id] })
        .expect(201)
    ).body as InboxItemDto;

    const ids = await listItemIds();
    expect(ids).toContain(merged.id);
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);

    // Hidden ≠ deleted: the detail endpoint still serves the sources.
    await request(app.getHttpServer()).get(`/api/v1/inbox/${a.id}`).expect(200);
  });

  it('split restores the originals untouched and removes the merged item and its blob', async () => {
    const a = await ingestAudio('merge-split-a', '2026-07-03T09:00:00.000Z');
    const b = await ingestAudio('merge-split-b', '2026-07-03T10:00:00.000Z');
    // The sources' own summaries land on a floating promise after commit —
    // let them settle so the pre-merge snapshot is stable.
    await waitForSummary(a.id);
    const preMergeA = (
      await request(app.getHttpServer()).get(`/api/v1/inbox/${a.id}`).expect(200)
    ).body as InboxItemDto;
    const merged = (
      await request(app.getHttpServer())
        .post('/api/v1/inbox/merge')
        .send({ itemIds: [a.id, b.id] })
        .expect(201)
    ).body as InboxItemDto;
    const mergedStorageKey = merged.source!.storageKey;

    const split = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${merged.id}/split`)
      .expect(201);
    expect(split.body).toEqual({ restoredItemIds: [a.id, b.id] });

    await request(app.getHttpServer()).get(`/api/v1/inbox/${merged.id}`).expect(404);
    const ids = await listItemIds();
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));

    // Originals untouched: identical extraction rows before and after.
    const restoredA = (
      await request(app.getHttpServer()).get(`/api/v1/inbox/${a.id}`).expect(200)
    ).body as InboxItemDto;
    expect(restoredA.extractions).toEqual(preMergeA.extractions);

    // Merged blob and link rows are gone.
    expect((await storage.headObject(mergedStorageKey)).exists).toBe(false);
    expect(await mergeRepo.count({ where: { mergedItemId: merged.id } })).toBe(0);

    // Splitting a non-merged item is a 400.
    await request(app.getHttpServer()).post(`/api/v1/inbox/${a.id}/split`).expect(400);
  });

  it('deleting a merged item behaves like split; deleting a hidden source is refused', async () => {
    const a = await ingestAudio('merge-del-a', '2026-07-04T09:00:00.000Z');
    const b = await ingestAudio('merge-del-b', '2026-07-04T10:00:00.000Z');
    const merged = (
      await request(app.getHttpServer())
        .post('/api/v1/inbox/merge')
        .send({ itemIds: [a.id, b.id] })
        .expect(201)
    ).body as InboxItemDto;

    // A hidden source cannot be deleted out from under its merge.
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${a.id}`).expect(409);

    await request(app.getHttpServer()).delete(`/api/v1/inbox/${merged.id}`).expect(204);
    const ids = await listItemIds();
    expect(ids).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('rejects invalid merge requests', async () => {
    const a = await ingestAudio('merge-guard-a', '2026-07-05T09:00:00.000Z');
    const b = await ingestAudio('merge-guard-b', '2026-07-05T10:00:00.000Z');

    // Fewer than two distinct recordings.
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id] })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id, a.id] })
      .expect(400);

    // Unknown recording.
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id, '00000000-0000-4000-8000-000000000000'] })
      .expect(404);

    // Non-audio item.
    const text = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'a note',
        occurredAt: '2026-07-05T11:00:00.000Z',
        idempotencyKey: 'merge-guard-text',
      })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id, text.body.id] })
      .expect(400);

    // A recording already inside a merge cannot be merged again.
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id, b.id] })
      .expect(201);
    const c = await ingestAudio('merge-guard-c', '2026-07-05T12:00:00.000Z');
    await request(app.getHttpServer())
      .post('/api/v1/inbox/merge')
      .send({ itemIds: [a.id, c.id] })
      .expect(409);
  });

  it('falls back to a real transcription run when a source has none, while still stitching diarization', async () => {
    const a = await ingestAudio('merge-fallback-a', '2026-07-06T09:00:00.000Z');
    const b = await ingestAudio('merge-fallback-b', '2026-07-06T10:00:00.000Z');

    // Sabotage A's transcription so stitching is impossible for that kind.
    const aTranscription = a.extractions.find((e) => e.kind === 'transcription')!;
    await extractionRepo.update(
      { id: aTranscription.id },
      { status: 'failed', content: null, segments: null },
    );

    const merged = (
      await request(app.getHttpServer())
        .post('/api/v1/inbox/merge')
        .send({ itemIds: [a.id, b.id] })
        .expect(201)
    ).body as InboxItemDto;

    // Real transcription ran against the merged audio (inline queue), so the
    // provider is the fake hosted API — not 'merged'.
    const transcription = latestOfKind(merged, 'transcription')!;
    expect(transcription.provider).toBe('fake-transcription');
    expect(transcription.status).toBe('succeeded');

    // Diarization was still stitched from the parts.
    expect(latestOfKind(merged, 'diarization')!.provider).toBe('merged');

    const summary = await waitForSummary(merged.id);
    expect(summary.status).toBe('succeeded');
  });
});

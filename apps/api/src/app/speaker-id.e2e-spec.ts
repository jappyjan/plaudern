import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). Same Path A setup as
// the ingestion e2e; the fake pyannoteAI pipeline emits one constant voice
// (matches the same profile across recordings) plus one per-recording voice.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { VoiceProfileDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { createE2eApp } from '../testing/e2e-app';

describe('Speaker identification (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  const itemIds: string[] = [];

  async function ingestAudio(key: string): Promise<string> {
    const audio = Buffer.from(`fake-audio-${key}`);
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: key,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  beforeAll(async () => {
    app = await createE2eApp();

    storage = app.get(StorageService) as InMemoryStorageService;
    itemIds.push(await ingestAudio('speaker-e2e-1'));
    itemIds.push(await ingestAudio('speaker-e2e-2'));
  });

  afterAll(async () => {
    await app.close();
  });

  it('diarizes committed audio (inline queue => synchronously)', async () => {
    for (const id of itemIds) {
      const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${id}`).expect(200);
      const diarization = res.body.extractions.find(
        (e: { kind: string }) => e.kind === 'diarization',
      );
      expect(diarization.status).toBe('succeeded');
      expect(diarization.segments).toHaveLength(2);
    }
  });

  it('links the recurring voice to ONE profile across recordings', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    const profiles: VoiceProfileDto[] = res.body.profiles;

    // Constant fake voice => one shared profile; per-recording voice => one
    // fresh unconfirmed profile per recording.
    expect(profiles).toHaveLength(3);
    const shared = profiles.filter((p) => p.recordingCount === 2);
    expect(shared).toHaveLength(1);
    expect(profiles.filter((p) => p.recordingCount === 1)).toHaveLength(2);
    expect(profiles.every((p) => p.status === 'unconfirmed')).toBe(true);
    expect(shared[0].totalSpeakingSeconds).toBeGreaterThan(0);
  });

  it('serves a segmented, speaker-attributed transcript', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemIds[0]}/speaker-transcript`)
      .expect(200);

    expect(res.body.mode).toBe('segmented');
    expect(res.body.text).toContain('test transcription');
    expect(res.body.speakers).toHaveLength(2);
    expect(res.body.segments.length).toBeGreaterThanOrEqual(2);
    // The fakes align transcript segment 0-2s with SPEAKER_00 and 2-4s with SPEAKER_01.
    expect(res.body.segments[0].speaker.label).toBe('SPEAKER_00');
    expect(res.body.segments[1].speaker.label).toBe('SPEAKER_01');
    expect(res.body.diarizationStatus).toBe('succeeded');
  });

  it('renames a profile (rename implies confirmation)', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    const shared = list.body.profiles.find((p: VoiceProfileDto) => p.recordingCount === 2);

    const res = await request(app.getHttpServer())
      .patch(`/api/v1/speakers/${shared.id}`)
      .send({ name: 'Alice' })
      .expect(200);
    expect(res.body.name).toBe('Alice');
    expect(res.body.status).toBe('confirmed');
    expect(res.body.recordings).toHaveLength(2);

    // The name shows up in the transcript read model.
    const transcript = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemIds[0]}/speaker-transcript`)
      .expect(200);
    const alice = transcript.body.speakers.find(
      (s: { profileId: string }) => s.profileId === shared.id,
    );
    expect(alice.name).toBe('Alice');
  });

  it('merges one profile into another and deletes the source', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    const singles = list.body.profiles.filter((p: VoiceProfileDto) => p.recordingCount === 1);
    expect(singles).toHaveLength(2);
    const [target, source] = singles;

    const res = await request(app.getHttpServer())
      .post(`/api/v1/speakers/${target.id}/merge`)
      .send({ sourceProfileId: source.id })
      .expect(201);
    expect(res.body.recordings).toHaveLength(2);

    await request(app.getHttpServer()).get(`/api/v1/speakers/${source.id}`).expect(404);
    const after = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    expect(after.body.profiles).toHaveLength(2);
  });

  it('rejects merging a profile into itself', async () => {
    const list = await request(app.getHttpServer()).get('/api/v1/speakers').expect(200);
    const [profile] = list.body.profiles;
    await request(app.getHttpServer())
      .post(`/api/v1/speakers/${profile.id}/merge`)
      .send({ sourceProfileId: profile.id })
      .expect(400);
  });

  it('returns flat mode with no speakers for text items', async () => {
    const text = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'no audio here',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'speaker-e2e-text',
      })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${text.body.id}/speaker-transcript`)
      .expect(200);
    expect(res.body.mode).toBe('none');
    expect(res.body.speakers).toHaveLength(0);
    expect(res.body.diarizationStatus).toBeNull();
  });
});

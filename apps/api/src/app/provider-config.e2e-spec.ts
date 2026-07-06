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
import request from 'supertest';
import type { ExtractorNodeDto } from '@plaudern/contracts';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { createE2eApp } from '../testing/e2e-app';
import { seedAiCapability } from '../testing/seed-ai-config';

/**
 * Provider selection is no longer env-driven (the old `SPEAKER_ID_PROVIDER`
 * fail-fast boot check is gone). A capability is off until the user assigns it a
 * provider connection in the DB — this spec pins that contract end to end: the
 * extractor graph reports the capability disabled and the pipeline no-ops, then
 * seeding a provider flips it on.
 */
describe('AI capability enablement is DB-driven (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp();
    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  async function graphNode(kind: string): Promise<ExtractorNodeDto | undefined> {
    const res = await request(app.getHttpServer()).get('/api/v1/extractions/graph').expect(200);
    return (res.body.extractors as ExtractorNodeDto[]).find((e) => e.kind === kind);
  }

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

  async function kinds(itemId: string): Promise<string[]> {
    const res = await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(200);
    return (res.body.extractions as { kind: string }[]).map((e) => e.kind);
  }

  it('always enables transcription (it runs without a configured provider)', async () => {
    expect(await graphNode('transcription')).toMatchObject({ kind: 'transcription', enabled: true });
  });

  it('reports diarization disabled until speaker_id has a provider, and no-ops in the pipeline', async () => {
    expect(await graphNode('diarization')).toMatchObject({ kind: 'diarization', enabled: false });

    // With speaker_id unconfigured the audio commit transcribes (and the
    // always-on sentinel classifies sensitivity, JJ-21) but never diarizes.
    const itemId = await ingestAudio('provider-config-off');
    const gotKinds = await kinds(itemId);
    expect(gotKinds).toContain('transcription');
    expect(gotKinds).not.toContain('diarization');
  });

  it('enables diarization once a provider is assigned, and the pipeline runs it', async () => {
    await seedAiCapability(app, 'speaker_id');
    expect(await graphNode('diarization')).toMatchObject({ kind: 'diarization', enabled: true });

    const itemId = await ingestAudio('provider-config-on');
    expect(await kinds(itemId)).toEqual(expect.arrayContaining(['transcription', 'diarization']));
  });
});

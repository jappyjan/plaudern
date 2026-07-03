import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.GEOCODER = 'stub';

import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { InboxService } from '@plaudern/inbox';
import { TRANSCRIPTION_PROVIDER } from '@plaudern/transcription';
import { DIARIZATION_PROVIDER } from '@plaudern/speaker-id';
import {
  FakeDiarizationProvider,
  FakeTranscriptionProvider,
} from '../testing/fake-providers';
import { AppModule } from './app.module';

describe('Reprocess whole pipeline (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TRANSCRIPTION_PROVIDER)
      .useValue(new FakeTranscriptionProvider())
      .overrideProvider(DIARIZATION_PROVIDER)
      .useValue(new FakeDiarizationProvider())
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();

    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
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

  it('404s for an unknown item', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/00000000-0000-0000-0000-00000000dead/reprocess')
      .expect(404);
  });
});

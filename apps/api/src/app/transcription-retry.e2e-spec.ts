import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
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

describe('Transcription retry (e2e, Path A)', () => {
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
    const audio = Buffer.from('fake-audio-bytes-for-retry');
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

  it('appends a fresh extraction row on retry (append-only history)', async () => {
    const itemId = await ingestAudio('e2e-retry-1');

    const res = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/transcription/retry`)
      .expect(201);

    const transcriptions = res.body.extractions.filter(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(transcriptions).toHaveLength(2);
    // Mapper returns newest-first; the inline queue ran the retry synchronously.
    expect(transcriptions[0].status).toBe('succeeded');
    expect(transcriptions[1].status).toBe('succeeded');
  });

  it('retries a failed transcription to success', async () => {
    const itemId = await ingestAudio('e2e-retry-failed');
    const before = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    await inbox.completeExtraction(before.body.extractions[0].id, {
      status: 'failed',
      error: 'provider exploded',
    });

    const res = await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/transcription/retry`)
      .expect(201);

    const latest = res.body.extractions.find(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(latest.status).toBe('succeeded');
    expect(latest.content).toContain('test transcription');
  });

  it('rejects retry while a transcription is still in flight', async () => {
    const itemId = await ingestAudio('e2e-retry-conflict');
    const item = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    await inbox.setExtractionStatus(item.body.extractions[0].id, 'processing');

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${itemId}/transcription/retry`)
      .expect(409);
  });

  it('rejects retry for items without an audio source', async () => {
    const text = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'not transcribable',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'e2e-retry-text',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/inbox/${text.body.id}/transcription/retry`)
      .expect(400);
  });

  it('404s for an unknown item', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/inbox/00000000-0000-0000-0000-00000000dead/transcription/retry')
      .expect(404);
  });
});

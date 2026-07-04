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
import type { InboxEvent } from '@plaudern/contracts';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { InboxEventsService, InboxService } from '@plaudern/inbox';
import { createE2eApp } from '../testing/e2e-app';

describe('Inbox item deletion (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;
  let events: InboxEventsService;

  beforeAll(async () => {
    app = await createE2eApp();

    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
    events = app.get(InboxEventsService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function ingestAudio(
    idempotencyKey: string,
  ): Promise<{ itemId: string; storageKey: string }> {
    const audio = Buffer.from('fake-audio-bytes-for-deletion');
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
    return { itemId: init.body.inboxItemId, storageKey: init.body.storageKey };
  }

  it('deletes the item, its blob and emits item.deleted', async () => {
    const { itemId, storageKey } = await ingestAudio('e2e-del-1');
    expect((await storage.headObject(storageKey)).exists).toBe(true);

    const seen: InboxEvent[] = [];
    const subscription = events.stream(DEFAULT_USER_ID).subscribe((event) => seen.push(event));

    await request(app.getHttpServer()).delete(`/api/v1/inbox/${itemId}`).expect(204);
    subscription.unsubscribe();

    await request(app.getHttpServer()).get(`/api/v1/inbox/${itemId}`).expect(404);
    const list = await request(app.getHttpServer()).get('/api/v1/inbox').expect(200);
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(itemId);
    expect((await storage.headObject(storageKey)).exists).toBe(false);
    expect(seen).toContainEqual({ type: 'item.deleted', itemId });
  });

  it('writes a tombstone for the deleted idempotency key', async () => {
    const { itemId } = await ingestAudio('e2e-del-tombstone');
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${itemId}`).expect(204);
    expect(await inbox.isIdempotencyKeyTombstoned(DEFAULT_USER_ID, 'e2e-del-tombstone')).toBe(
      true,
    );
  });

  it('404s for an unknown item and for a second delete', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/inbox/00000000-0000-0000-0000-00000000dead')
      .expect(404);

    const { itemId } = await ingestAudio('e2e-del-twice');
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${itemId}`).expect(204);
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${itemId}`).expect(404);
  });

  it('still allows manual re-ingestion with the same key after a delete', async () => {
    // Tombstones only block automated sync — a deliberate re-upload must work.
    const first = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'delete me, then bring me back',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'e2e-del-reingest',
      })
      .expect(201);
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${first.body.id}`).expect(204);

    const second = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'delete me, then bring me back',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'e2e-del-reingest',
      })
      .expect(201);
    expect(second.body.id).not.toBe(first.body.id);

    // Deleting again upserts the existing tombstone instead of conflicting.
    await request(app.getHttpServer()).delete(`/api/v1/inbox/${second.body.id}`).expect(204);
  });

  it('deletes the stored blob of a text item too', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'text note with a blob behind it',
        occurredAt: '2026-07-01T11:00:00.000Z',
        idempotencyKey: 'e2e-del-text-blob',
      })
      .expect(201);
    const storageKey = created.body.source.storageKey;
    expect((await storage.headObject(storageKey)).exists).toBe(true);

    await request(app.getHttpServer()).delete(`/api/v1/inbox/${created.body.id}`).expect(204);
    expect((await storage.headObject(storageKey)).exists).toBe(false);
  });
});

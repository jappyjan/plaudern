import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.GEOCODER = 'stub';

import * as http from 'node:http';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { InboxEvent } from '@plaudern/contracts';
import { DEFAULT_USER_ID } from '@plaudern/persistence';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { InboxEventsService } from '@plaudern/inbox';
import { createE2eApp } from '../testing/e2e-app';
import { seedAiCapability } from '../testing/seed-ai-config';

describe('Inbox events (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let events: InboxEventsService;

  beforeAll(async () => {
    app = await createE2eApp();

    // The audio-ingest test asserts a full diarization lifecycle alongside the
    // transcription; diarization is gated on the speaker_id capability.
    await seedAiCapability(app, 'speaker_id');

    storage = app.get(StorageService) as InMemoryStorageService;
    events = app.get(InboxEventsService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes commit + extraction lifecycle events for an audio ingest', async () => {
    const seen: InboxEvent[] = [];
    const sub = events.stream(DEFAULT_USER_ID).subscribe((e) => seen.push(e));

    const audio = Buffer.from('fake-audio-bytes-for-events');
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'audio',
        contentType: 'audio/mpeg',
        byteSize: audio.byteLength,
        occurredAt: '2026-07-01T09:30:00.000Z',
        idempotencyKey: 'e2e-events-1',
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, audio, 'audio/mpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    sub.unsubscribe();

    const itemId = init.body.inboxItemId;
    const types = seen.filter((e) => 'itemId' in e && e.itemId === itemId);
    // Audio commit runs transcription AND diarization (both inline, with fake
    // providers); once transcription succeeds the always-on sensitivity sentinel
    // (JJ-21) runs too. Each of the three contributes a full
    // queued -> processing -> succeeded lifecycle. Assert by multiset (the exact
    // interleaving of the microtask-scheduled sentinel is not contractual).
    expect(types.filter((e) => e.type === 'item.committed')).toHaveLength(1);
    const updated = types.filter((e) => e.type === 'extraction.updated');
    expect(updated).toHaveLength(9);
    const byStatus = (status: string) =>
      updated.filter((e) => e.type === 'extraction.updated' && e.status === status).length;
    expect(byStatus('queued')).toBe(3);
    expect(byStatus('processing')).toBe(3);
    expect(byStatus('succeeded')).toBe(3);
  });

  it('publishes item.created for inline text ingest', async () => {
    const seen: InboxEvent[] = [];
    const sub = events.stream(DEFAULT_USER_ID).subscribe((e) => seen.push(e));

    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'an event-producing thought',
        occurredAt: '2026-07-01T10:00:00.000Z',
        idempotencyKey: 'e2e-events-text',
      })
      .expect(201);
    sub.unsubscribe();

    expect(seen).toContainEqual({ type: 'item.created', itemId: res.body.id });
  });

  it('serves the SSE stream and delivers events over HTTP', async () => {
    const server = app.getHttpServer() as http.Server;
    if (!server.listening) {
      await new Promise<void>((resolve) => server.listen(0, resolve));
    }
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${address.port}/api/v1/events`, resolve)
        .on('error', reject);
    });
    let emitTimer: ReturnType<typeof setInterval> | null = null;
    try {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      // A bus event must arrive as an SSE frame on the open connection. Emit
      // repeatedly: headers can arrive before the server-side subscription is
      // fully wired, so a single emit could race past it.
      let buffer = '';
      const frame = new Promise<string>((resolve) => {
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('item.created')) resolve(buffer);
        });
      });
      emitTimer = setInterval(
        () =>
          events.emit(DEFAULT_USER_ID, {
            type: 'item.created',
            itemId: '11111111-1111-1111-1111-111111111111',
          }),
        100,
      );
      const received = await Promise.race([
        frame,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error(`no SSE frame received; buffer: ${buffer}`)), 10_000),
        ),
      ]);
      expect(received).toContain('item.created');
      expect(received).toContain('11111111-1111-1111-1111-111111111111');
    } finally {
      if (emitTimer) clearInterval(emitTimer);
      res.destroy();
    }
  });
});

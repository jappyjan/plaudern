import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init). See plan §6 Path A.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { WEB_SNAPSHOT_FETCH, type FetchLike } from '@plaudern/ingestion';
import { createE2eApp } from '../testing/e2e-app';

const ARTICLE_URL = 'https://example.com/interesting-article';
const DOWN_URL = 'https://down.example.com/article';
const BINARY_URL = 'https://example.com/photo.jpg';

const ARTICLE_HTML = `<!doctype html>
<html>
  <head><title>Interesting Article — Example</title></head>
  <body>
    <nav><a href="/">Home</a></nav>
    <article>
      <h1>Interesting Article</h1>
      <p>The readable body of the shared page.</p>
    </article>
    <footer>legal footer</footer>
  </body>
</html>`;

/** Deterministic fake network: one good page, one dead host, one binary. */
const fakeFetch: FetchLike = async (url) => {
  if (url === DOWN_URL) throw new Error('ECONNREFUSED');
  const isBinary = url === BINARY_URL;
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'content-type' ? (isBinary ? 'image/jpeg' : 'text/html; charset=utf-8') : null,
    },
    text: async () => (isBinary ? 'not html' : ARTICLE_HTML),
  };
};

describe('Web clipper ingestion (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;

  beforeAll(async () => {
    app = await createE2eApp((builder) =>
      builder.overrideProvider(WEB_SNAPSHOT_FETCH).useValue(fakeFetch),
    );
    storage = app.get(StorageService) as InMemoryStorageService;
  });

  afterAll(async () => {
    await app.close();
  });

  const readPayload = async (storageKey: string): Promise<string> => {
    const stream = await storage.getObjectStream(storageKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };

  it('stores a client-provided readable snapshot without fetching the page', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/web')
      .send({
        url: 'https://client.example.com/page',
        title: 'Client Title',
        text: 'Readable text captured on the client.',
        occurredAt: '2026-07-04T10:00:00.000Z',
        idempotencyKey: 'e2e-web-client-1',
      })
      .expect(201);

    expect(res.body.sourceType).toBe('web');
    expect(res.body.source.uploadStatus).toBe('committed');
    expect(res.body.source.contentType).toBe('text/plain');
    expect(res.body.metadata.url).toBe('https://client.example.com/page');
    expect(res.body.metadata.web).toEqual({ snapshotSource: 'client' });
    expect(res.body.metadata.tags.title).toBe('Client Title');

    const payload = await readPayload(res.body.source.storageKey);
    expect(payload).toContain('https://client.example.com/page');
    expect(payload).toContain('Readable text captured on the client.');

    // The snapshot enters the extraction DAG as a passthrough transcription,
    // so web clips get the same downstream processing as every other source.
    const get = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${res.body.id}`)
      .expect(200);
    const transcription = get.body.extractions.find(
      (e: { kind: string }) => e.kind === 'transcription',
    );
    expect(transcription.status).toBe('succeeded');
    expect(transcription.provider).toBe('text-passthrough');
    expect(transcription.content).toContain('Readable text captured on the client.');
  });

  it('extracts a readable snapshot server-side when only a URL is shared', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/web')
      .send({
        url: ARTICLE_URL,
        occurredAt: '2026-07-04T10:05:00.000Z',
        idempotencyKey: 'e2e-web-server-1',
      })
      .expect(201);

    expect(res.body.metadata.web).toEqual({ snapshotSource: 'server' });
    // Title extracted from the page, readable text stored, chrome dropped.
    expect(res.body.metadata.tags.title).toBe('Interesting Article — Example');
    const payload = await readPayload(res.body.source.storageKey);
    expect(payload).toContain('The readable body of the shared page.');
    expect(payload).not.toContain('legal footer');
  });

  it('falls back to storing just the URL when the page cannot be fetched', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/web')
      .send({
        url: DOWN_URL,
        occurredAt: '2026-07-04T10:10:00.000Z',
        idempotencyKey: 'e2e-web-down-1',
      })
      .expect(201);

    expect(res.body.sourceType).toBe('web');
    expect(res.body.metadata.web).toEqual({ snapshotSource: 'none' });
    expect(await readPayload(res.body.source.storageKey)).toBe(DOWN_URL);
  });

  it('falls back to URL-only for non-HTML content types', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/ingest/web')
      .send({
        url: BINARY_URL,
        occurredAt: '2026-07-04T10:15:00.000Z',
        idempotencyKey: 'e2e-web-binary-1',
      })
      .expect(201);
    expect(res.body.metadata.web).toEqual({ snapshotSource: 'none' });
  });

  it('is idempotent: re-sharing with the same key returns the same item', async () => {
    const body = {
      url: ARTICLE_URL,
      occurredAt: '2026-07-04T10:20:00.000Z',
      idempotencyKey: 'e2e-web-dupe',
    };
    const first = await request(app.getHttpServer()).post('/api/v1/ingest/web').send(body).expect(201);
    const second = await request(app.getHttpServer()).post('/api/v1/ingest/web').send(body).expect(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it('rejects an invalid URL', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/web')
      .send({
        url: 'not-a-url',
        occurredAt: '2026-07-04T10:25:00.000Z',
        idempotencyKey: 'e2e-web-bad-url',
      })
      .expect(400);
  });

  it('rejects the presigned init flow for the web source', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'web',
        contentType: 'text/plain',
        byteSize: 10,
        occurredAt: '2026-07-04T10:30:00.000Z',
        idempotencyKey: 'e2e-web-init',
      })
      .expect(400);
  });

  it('lists the web clip in the inbox', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/inbox?limit=50').expect(200);
    const webItems = res.body.items.filter((i: { sourceType: string }) => i.sourceType === 'web');
    expect(webItems.length).toBeGreaterThanOrEqual(3);
  });
});

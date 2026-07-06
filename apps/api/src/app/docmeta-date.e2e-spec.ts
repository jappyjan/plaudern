import 'reflect-metadata';

// Hardware-free, infra-free verification. Set BEFORE modules load.
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true';
process.env.GEOCODER = 'stub';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InMemoryStorageService, StorageService } from '@plaudern/storage';
import { InboxService } from '@plaudern/inbox';
import { DocMetaPersistenceService } from '@plaudern/docmeta';
import type { ExtractedDocMeta } from '@plaudern/contracts';
import { createE2eApp } from '../testing/e2e-app';

/**
 * End-to-end guard for JJ "document date as the item's date": the `docmeta`
 * extractor pulls the date printed on a scan, and every item-date read model
 * (item detail, inbox list, vault) prefers it over the upload time — while the
 * immutable envelope's `occurredAt` is left untouched. When no date is found,
 * the read models fall back to `occurredAt`.
 */
describe('Document date prefers over upload date (e2e, Path A)', () => {
  let app: INestApplication;
  let storage: InMemoryStorageService;
  let inbox: InboxService;
  let persistence: DocMetaPersistenceService;

  const UPLOAD_AT = '2026-07-01T09:30:00.000Z';

  const baseDoc: ExtractedDocMeta = {
    documentType: 'invoice',
    title: 'Invoice',
    summary: null,
    issuer: 'ACME GmbH',
    fields: [],
    amount: null,
    currency: null,
    iban: null,
    documentDate: null,
    expiryDate: null,
    cancellationDate: null,
    contact: null,
    confidence: 0.9,
  };

  beforeAll(async () => {
    app = await createE2eApp();
    storage = app.get(StorageService) as InMemoryStorageService;
    inbox = app.get(InboxService);
    persistence = app.get(DocMetaPersistenceService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Ingest a committed image item and return its id. OCR is disabled here, so
   * nothing runs the pipeline — we drive docmeta persistence directly. */
  async function ingestImage(idempotencyKey: string): Promise<string> {
    const bytes = Buffer.from('fake-scan-bytes');
    const init = await request(app.getHttpServer())
      .post('/api/v1/ingest/init')
      .send({
        sourceType: 'image',
        contentType: 'image/jpeg',
        byteSize: bytes.byteLength,
        occurredAt: UPLOAD_AT,
        idempotencyKey,
      })
      .expect(201);
    await storage.putObject(init.body.storageKey, bytes, 'image/jpeg');
    await request(app.getHttpServer())
      .post(`/api/v1/ingest/${init.body.inboxItemId}/commit`)
      .expect(201);
    return init.body.inboxItemId;
  }

  /** Persist a docmeta result for an item as the pipeline would. */
  async function persistDocMeta(itemId: string, docMeta: ExtractedDocMeta): Promise<void> {
    const item = await inbox.getItemById(itemId);
    if (!item) throw new Error('item vanished');
    const ext = await inbox.addExtraction(itemId, 'docmeta', 'test-provider', 2);
    await inbox.completeExtraction(ext.id, { status: 'succeeded', content: '{}' });
    await persistence.persist(item.userId, itemId, ext.id, UPLOAD_AT, docMeta);
  }

  it('prefers the extracted document date across item, list and vault; occurredAt stays the upload time', async () => {
    const itemId = await ingestImage('e2e-docdate-present');
    // German day-first date printed on the scan → resolved to an absolute ISO.
    await persistDocMeta(itemId, { ...baseDoc, documentDate: '14.03.2026' });
    const RESOLVED = '2026-03-14T00:00:00.000Z';

    // Item docmeta tab (DocumentDto).
    const docmeta = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}/docmeta`)
      .expect(200);
    expect(docmeta.body.document.documentDate).toBe(RESOLVED);
    expect(docmeta.body.document.occurredAt).toBe(UPLOAD_AT);

    // Item detail (InboxItemDto): documentDate present, occurredAt unchanged.
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    expect(detail.body.documentDate).toBe(RESOLVED);
    expect(detail.body.occurredAt).toBe(UPLOAD_AT);

    // Inbox list.
    const list = await request(app.getHttpServer()).get('/api/v1/inbox').expect(200);
    const listed = list.body.items.find((i: { id: string }) => i.id === itemId);
    expect(listed.documentDate).toBe(RESOLVED);
    expect(listed.occurredAt).toBe(UPLOAD_AT);

    // Vault.
    const vault = await request(app.getHttpServer()).get('/api/v1/documents').expect(200);
    const doc = vault.body.documents.find((d: { inboxItemId: string }) => d.inboxItemId === itemId);
    expect(doc.documentDate).toBe(RESOLVED);
  });

  it('falls back to occurredAt when the document carries no clear date', async () => {
    const itemId = await ingestImage('e2e-docdate-absent');
    await persistDocMeta(itemId, { ...baseDoc, documentType: 'letter', documentDate: null });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/inbox/${itemId}`)
      .expect(200);
    expect(detail.body.documentDate).toBeNull();
    expect(detail.body.occurredAt).toBe(UPLOAD_AT);
  });
});

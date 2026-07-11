import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CalendarEventEntity,
  CalendarFeedEntity,
  DEFAULT_USER_ID,
  DocumentMetadataEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  RecordingEventLinkEntity,
  RecordingMergeEntity,
} from '@plaudern/persistence';
import { CalendarEventsService } from './calendar-events.service';

describe('CalendarEventsService.recordingsInRange', () => {
  let dataSource: DataSource;
  let service: CalendarEventsService;

  // A July grid range: the query is by the item's *effective* date.
  const FROM = '2026-07-01T00:00:00.000Z';
  const TO = '2026-07-31T23:59:59.999Z';

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    service = new CalendarEventsService(
      dataSource.getRepository(CalendarEventEntity),
      dataSource.getRepository(CalendarFeedEntity),
      dataSource.getRepository(RecordingEventLinkEntity),
      dataSource.getRepository(InboxItemEntity),
      dataSource.getRepository(RecordingMergeEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createItem(
    occurredAt: string,
    overrides: Partial<InboxItemEntity> = {},
  ): Promise<InboxItemEntity> {
    return dataSource.getRepository(InboxItemEntity).save({
      userId: DEFAULT_USER_ID,
      deviceId: null,
      sourceType: 'image' as const,
      occurredAt,
      idempotencyKey: `key-${occurredAt}-${Math.random()}`,
      metadata: null,
      ...overrides,
    });
  }

  /** Attach a docmeta row (its generated title + detected document date) to an item. */
  async function attachDocMeta(
    item: InboxItemEntity,
    title: string,
    documentDate: string | null,
  ): Promise<void> {
    const extraction = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'docmeta' as const,
      provider: 'test',
      status: 'succeeded' as const,
      content: null,
    });
    await dataSource.getRepository(DocumentMetadataEntity).save({
      userId: DEFAULT_USER_ID,
      inboxItemId: item.id,
      extractionId: extraction.id,
      documentType: 'prescription' as const,
      title,
      documentDate,
    });
  }

  it('projects the scanned-document title and detected date onto the summary', async () => {
    const item = await createItem('2026-07-05T21:25:00.000Z', {
      source: {
        storageKey: 'blob/x',
        contentType: 'image/jpeg',
        byteSize: 1,
        checksum: null,
        originalFilename: 'image.jpg',
        uploadStatus: 'committed',
      } as InboxItemEntity['source'],
    });
    await attachDocMeta(item, 'Überweisungsschein', '2026-07-03T00:00:00.000Z');

    const [recording] = await service.recordingsInRange(DEFAULT_USER_ID, FROM, TO);

    expect(recording).toMatchObject({
      id: item.id,
      title: 'Überweisungsschein',
      documentDate: '2026-07-03T00:00:00.000Z',
      originalFilename: 'image.jpg',
    });
  });

  it('includes an item whose document date is in range even when its upload time is not', async () => {
    // Uploaded in August (outside the July range) but the document is dated July 3.
    const item = await createItem('2026-08-02T09:00:00.000Z');
    await attachDocMeta(item, 'Rechnung', '2026-07-03T00:00:00.000Z');

    const ids = (await service.recordingsInRange(DEFAULT_USER_ID, FROM, TO)).map((r) => r.id);
    expect(ids).toContain(item.id);
  });

  it('excludes an item whose upload time is in range but whose document date is not', async () => {
    // Uploaded in July but the document itself is dated in June (out of range).
    const item = await createItem('2026-07-05T09:00:00.000Z');
    await attachDocMeta(item, 'Alte Rechnung', '2026-06-15T00:00:00.000Z');

    const ids = (await service.recordingsInRange(DEFAULT_USER_ID, FROM, TO)).map((r) => r.id);
    expect(ids).not.toContain(item.id);
  });

  it('falls back to occurredAt and a null title for a plain recording with no docmeta', async () => {
    const item = await createItem('2026-07-10T08:00:00.000Z', { sourceType: 'audio' as const });

    const [recording] = await service.recordingsInRange(DEFAULT_USER_ID, FROM, TO);
    expect(recording).toMatchObject({ id: item.id, title: null, documentDate: null });
  });
});

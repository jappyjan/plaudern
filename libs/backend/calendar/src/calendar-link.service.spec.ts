import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CalendarEventEntity,
  CalendarFeedEntity,
  DEFAULT_USER_ID,
  InboxItemEntity,
  RecordingEventLinkEntity,
} from '@plaudern/persistence';
import { CalendarLinkService, overlaps } from './calendar-link.service';

describe('overlaps', () => {
  const eventStart = '2026-07-01T09:00:00.000Z';
  const eventEnd = '2026-07-01T10:00:00.000Z';

  it('matches a zero-duration recording inside the event', () => {
    expect(overlaps('2026-07-01T09:30:00.000Z', '2026-07-01T09:30:00.000Z', eventStart, eventEnd)).toBe(true);
  });

  it('matches exactly at the event boundaries (inclusive)', () => {
    expect(overlaps(eventStart, eventStart, eventStart, eventEnd)).toBe(true);
    expect(overlaps(eventEnd, eventEnd, eventStart, eventEnd)).toBe(true);
  });

  it('rejects a recording outside the event', () => {
    expect(overlaps('2026-07-01T10:00:00.001Z', '2026-07-01T10:30:00.000Z', eventStart, eventEnd)).toBe(false);
    expect(overlaps('2026-07-01T08:00:00.000Z', '2026-07-01T08:59:59.999Z', eventStart, eventEnd)).toBe(false);
  });

  it('matches a recording that starts before and runs into the event', () => {
    expect(overlaps('2026-07-01T08:30:00.000Z', '2026-07-01T09:15:00.000Z', eventStart, eventEnd)).toBe(true);
  });
});

describe('CalendarLinkService', () => {
  let dataSource: DataSource;
  let service: CalendarLinkService;

  const WINDOW_START = new Date('2026-06-01T00:00:00.000Z');
  const WINDOW_END = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    service = new CalendarLinkService(
      dataSource.getRepository(RecordingEventLinkEntity),
      dataSource.getRepository(CalendarEventEntity),
      dataSource.getRepository(InboxItemEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createFeed(): Promise<CalendarFeedEntity> {
    return dataSource.getRepository(CalendarFeedEntity).save({
      userId: DEFAULT_USER_ID,
      name: 'Test feed',
      providerType: 'ics' as const,
      urlEncrypted: 'v1:x:y:z',
      urlHash: 'hash',
      urlMasked: 'example.com/…test.ics',
      enabled: true,
    });
  }

  async function createEvent(
    feedId: string,
    startAt: string,
    endAt: string,
    uid = `uid-${startAt}`,
  ): Promise<CalendarEventEntity> {
    return dataSource.getRepository(CalendarEventEntity).save({
      userId: DEFAULT_USER_ID,
      feedId,
      externalUid: uid,
      instanceStart: startAt,
      startAt,
      endAt,
      isAllDay: false,
      title: 'Event',
    });
  }

  async function createItem(
    occurredAt: string,
    metadata: Record<string, unknown> | null = null,
  ): Promise<InboxItemEntity> {
    return dataSource.getRepository(InboxItemEntity).save({
      userId: DEFAULT_USER_ID,
      deviceId: null,
      sourceType: 'audio' as const,
      occurredAt,
      idempotencyKey: `key-${occurredAt}-${Math.random()}`,
      metadata,
    });
  }

  function findLinks(): Promise<RecordingEventLinkEntity[]> {
    return dataSource.getRepository(RecordingEventLinkEntity).find();
  }

  it('auto-links a recording inside an event window', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const item = await createItem('2026-07-01T09:30:00.000Z');

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);

    const links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      inboxItemId: item.id,
      calendarEventId: event.id,
      origin: 'auto',
      status: 'active',
    });
  });

  it('does not link a recording outside every event', async () => {
    const feed = await createFeed();
    await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    await createItem('2026-07-01T11:00:00.000Z');

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    expect(await findLinks()).toHaveLength(0);
  });

  it('uses metadata.durationMs to extend the recording into an event', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    // Starts 30 min before the event, runs 45 min → overlaps.
    await createItem('2026-07-01T08:30:00.000Z', { durationMs: 45 * 60 * 1000 });

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    const links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0].calendarEventId).toBe(event.id);
  });

  it('uses metadata.tags.durationSeconds as duration fallback', async () => {
    const feed = await createFeed();
    await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    await createItem('2026-07-01T08:30:00.000Z', { tags: { durationSeconds: 45 * 60 } });

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    expect(await findLinks()).toHaveLength(1);
  });

  it('links a long recording to every event it spans', async () => {
    const feed = await createFeed();
    await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z', 'uid-a');
    await createEvent(feed.id, '2026-07-01T10:30:00.000Z', '2026-07-01T11:00:00.000Z', 'uid-b');
    await createItem('2026-07-01T09:30:00.000Z', { durationMs: 90 * 60 * 1000 });

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    expect(await findLinks()).toHaveLength(2);
  });

  it('removes a stale auto link when the event no longer overlaps', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    await createItem('2026-07-01T09:30:00.000Z');
    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    expect(await findLinks()).toHaveLength(1);

    // The event moves to the afternoon (sync updated the cached row).
    event.startAt = '2026-07-01T14:00:00.000Z';
    event.endAt = '2026-07-01T15:00:00.000Z';
    await dataSource.getRepository(CalendarEventEntity).save(event);

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    expect(await findLinks()).toHaveLength(0);
  });

  it('never removes a manual link, even without overlap', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T14:00:00.000Z', '2026-07-01T15:00:00.000Z');
    const item = await createItem('2026-07-01T09:30:00.000Z');
    await service.link(item.id, event.id);

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);

    const links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ origin: 'manual', status: 'active' });
  });

  it('unlink suppresses and the auto pass never resurrects the pair', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const item = await createItem('2026-07-01T09:30:00.000Z');
    await service.autoLinkWindow(WINDOW_START, WINDOW_END);

    await service.unlink(item.id, event.id);
    let links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe('suppressed');

    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0].status).toBe('suppressed');
  });

  it('manual link revives a suppressed pair', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const item = await createItem('2026-07-01T09:30:00.000Z');
    await service.autoLinkWindow(WINDOW_START, WINDOW_END);
    await service.unlink(item.id, event.id);

    await service.link(item.id, event.id);

    const links = await findLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ origin: 'manual', status: 'active' });
  });

  it('unlink of a non-existent link 404s', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const item = await createItem('2026-07-01T11:30:00.000Z');
    await expect(service.unlink(item.id, event.id)).rejects.toThrow('link not found');
  });

  it('manual link validates that both sides exist', async () => {
    const feed = await createFeed();
    const event = await createEvent(feed.id, '2026-07-01T09:00:00.000Z', '2026-07-01T10:00:00.000Z');
    const item = await createItem('2026-07-01T09:30:00.000Z');
    await expect(service.link('00000000-0000-0000-0000-00000000dead', event.id)).rejects.toThrow(
      'inbox item not found',
    );
    await expect(service.link(item.id, '00000000-0000-0000-0000-00000000dead')).rejects.toThrow(
      'calendar event not found',
    );
  });
});

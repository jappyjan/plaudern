import 'reflect-metadata';

// Configure the app for hardware-free, infra-free verification BEFORE the
// modules load (ConfigModule reads process.env at init).
process.env.DATABASE_DRIVER = 'sqlite';
process.env.DATABASE_URL = ':memory:';
process.env.STORAGE_DRIVER = 'memory';
process.env.QUEUE_DRIVER = 'inline';
process.env.AUTH_DISABLED = 'true'; // single-user mode — auth has its own spec
process.env.APP_ENCRYPTION_SECRET = 'test-secret';
process.env.PLAUD_POLL_INTERVAL_MS = '0'; // no background pollers in tests
process.env.CALENDAR_POLL_INTERVAL_MS = '0';

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { CALENDAR_FETCH } from '@plaudern/calendar';
import { createE2eApp } from '../testing/e2e-app';

const FEED_URL = 'https://calendar.example.com/private-token-123/basic.ics';
const DAY_MS = 24 * 60 * 60 * 1000;

/** A day ~10 days in the past, comfortably inside the ±90d sync window. */
const eventDay = new Date(Date.now() - 10 * DAY_MS).toISOString().slice(0, 10);
const dayStamp = eventDay.replace(/-/g, '');
const iso = (time: string) => `${eventDay}T${time}.000Z`;

function icsBody(): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Plaudern//E2E//EN',
    'X-WR-CALNAME:E2E Calendar',
    'BEGIN:VEVENT',
    'UID:meeting-1@e2e',
    `DTSTART:${dayStamp}T090000Z`,
    `DTEND:${dayStamp}T100000Z`,
    'SUMMARY:Sprint planning',
    'LOCATION:Room 1',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday-1@e2e',
    `DTSTART;VALUE=DATE:${dayStamp}`,
    'SUMMARY:Conference day',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:weekly-1@e2e',
    `DTSTART:${dayStamp}T160000Z`,
    `DTEND:${dayStamp}T163000Z`,
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'SUMMARY:Weekly sync',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

describe('Calendar feeds + linking (e2e)', () => {
  let app: INestApplication;

  let nextResponse: () => Response;
  const fakeFetch = jest.fn(async () => nextResponse());
  const okResponse = () =>
    new Response(icsBody(), { status: 200, headers: { 'content-type': 'text/calendar' } });

  beforeAll(async () => {
    nextResponse = okResponse;
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(CALENDAR_FETCH)
        .useValue(fakeFetch),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  /** Feed syncs run fire-and-forget — poll the feed status until it lands. */
  async function waitForSync(feedId: string, previousSyncAt: string | null): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
      const feed = res.body.feeds.find((candidate: { id: string }) => candidate.id === feedId);
      if (feed?.lastSyncAt && feed.lastSyncAt !== previousSyncAt && !res.body.syncRunning) {
        return feed;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('calendar sync never finished');
  }

  function rangeQuery(): string {
    const from = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const to = new Date(Date.now() + 30 * DAY_MS).toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  }

  let feedId: string;
  let timedEventId: string;
  let allDayEventId: string;
  let itemId: string;

  it('starts with no feeds', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
    expect(res.body).toEqual({ feeds: [], syncRunning: false, googleConfigured: false });
  });

  it('tests a feed URL without storing it', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/calendar/feeds/test')
      .send({ url: FEED_URL })
      .expect(201);
    expect(res.body).toMatchObject({ ok: true, error: null, calendarName: 'E2E Calendar' });
    expect(res.body.eventCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects creating a feed whose URL does not respond', async () => {
    nextResponse = () => new Response('nope', { status: 403 });
    const res = await request(app.getHttpServer())
      .post('/api/v1/calendar/feeds')
      .send({ name: 'Broken', url: 'https://calendar.example.com/broken.ics' })
      .expect(400);
    expect(res.body.message).toContain('HTTP 403');
    // The secret URL never leaks into the error.
    expect(JSON.stringify(res.body)).not.toContain('broken.ics');
    nextResponse = okResponse;
  });

  it('creates a feed, auto-syncs it, and never exposes the URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/calendar/feeds')
      .send({ name: 'Work', url: FEED_URL, color: '#3b82f6', autoLink: true })
      .expect(201);
    feedId = res.body.id;
    expect(res.body).toMatchObject({ name: 'Work', providerType: 'ics', enabled: true, autoLink: true });
    expect(JSON.stringify(res.body)).not.toContain('private-token-123');

    const feed = await waitForSync(feedId, null);
    expect(feed.lastSyncStatus).toBe('ok');
    // 1 timed + 1 all-day + 3 weekly instances
    expect(feed.lastSyncEventCount).toBe(5);
  });

  it('rejects a duplicate feed URL', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/calendar/feeds')
      .send({ name: 'Copy', url: `webcal://${FEED_URL.slice('https://'.length)}` })
      .expect(409);
    expect(res.body.message).toContain('already subscribed as "Work"');
  });

  it('returns expanded events in a range', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/calendar/events?${rangeQuery()}`)
      .expect(200);
    const events = res.body.events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThanOrEqual(3);

    const timed = events.find((event) => event.title === 'Sprint planning');
    expect(timed).toMatchObject({
      startAt: iso('09:00:00'),
      endAt: iso('10:00:00'),
      isAllDay: false,
      feedName: 'Work',
      feedColor: '#3b82f6',
      location: 'Room 1',
      linkedRecordingIds: [],
    });
    timedEventId = timed!.id as string;

    const allDay = events.find((event) => event.title === 'Conference day');
    expect(allDay).toMatchObject({ isAllDay: true, startAt: iso('00:00:00') });
    allDayEventId = allDay!.id as string;

    const weekly = events.filter((event) => event.title === 'Weekly sync');
    expect(weekly.length).toBeGreaterThanOrEqual(2); // 3rd instance may fall outside ±30d
  });

  it('rejects an events query with a backwards range', async () => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() - DAY_MS).toISOString();
    await request(app.getHttpServer())
      .get(`/api/v1/calendar/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .expect(500); // zod parse error — no global exception filter maps these
  });

  it('auto-links a recording ingested during an event', async () => {
    const ingest = await request(app.getHttpServer())
      .post('/api/v1/ingest/text')
      .send({
        text: 'notes taken during sprint planning',
        occurredAt: iso('09:30:00'),
        idempotencyKey: 'calendar-e2e-1',
      })
      .expect(201);
    itemId = ingest.body.id;

    const before = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
    await request(app.getHttpServer()).post('/api/v1/calendar/sync').expect(201);
    await waitForSync(feedId, before.body.feeds[0].lastSyncAt);

    // Recording → events: linked to both the timed event and the all-day event.
    const itemEvents = await request(app.getHttpServer())
      .get(`/api/v1/calendar/items/${itemId}/events`)
      .expect(200);
    const linkedIds = itemEvents.body.events.map((event: { id: string }) => event.id);
    expect(linkedIds).toContain(timedEventId);
    expect(linkedIds).toContain(allDayEventId);

    // Events → recordings: the range query and the detail view both see it.
    const events = await request(app.getHttpServer())
      .get(`/api/v1/calendar/events?${rangeQuery()}`)
      .expect(200);
    const timed = events.body.events.find((event: { id: string }) => event.id === timedEventId);
    expect(timed.linkedRecordingIds).toEqual([itemId]);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/calendar/events/${timedEventId}`)
      .expect(200);
    expect(detail.body.recordings).toHaveLength(1);
    expect(detail.body.recordings[0]).toMatchObject({ id: itemId, occurredAt: iso('09:30:00') });
  });

  it('lists the recording in the calendar recordings range query', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/calendar/recordings?${rangeQuery()}`)
      .expect(200);
    const recording = res.body.recordings.find((candidate: { id: string }) => candidate.id === itemId);
    expect(recording).toBeDefined();
    expect(recording.linkedEventIds).toContain(timedEventId);
  });

  it('manual unlink survives a re-sync (suppression)', async () => {
    await request(app.getHttpServer())
      .delete(`/api/v1/calendar/links/${itemId}/${timedEventId}`)
      .expect(204);

    const before = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
    await request(app.getHttpServer()).post('/api/v1/calendar/sync').expect(201);
    await waitForSync(feedId, before.body.feeds[0].lastSyncAt);

    const itemEvents = await request(app.getHttpServer())
      .get(`/api/v1/calendar/items/${itemId}/events`)
      .expect(200);
    const linkedIds = itemEvents.body.events.map((event: { id: string }) => event.id);
    expect(linkedIds).not.toContain(timedEventId);
    expect(linkedIds).toContain(allDayEventId); // the other link is untouched
  });

  it('manual link revives the pair and shows up in the event detail', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/calendar/links')
      .send({ inboxItemId: itemId, eventId: timedEventId })
      .expect(201)
      .expect((res) => {
        expect(res.body).toEqual({ inboxItemId: itemId, eventId: timedEventId, origin: 'manual' });
      });

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/calendar/events/${timedEventId}`)
      .expect(200);
    expect(detail.body.recordings.map((rec: { id: string }) => rec.id)).toContain(itemId);
  });

  it('a feed fetch failure is recorded per-feed without breaking anything', async () => {
    nextResponse = () => {
      throw new Error('connection reset');
    };
    const before = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
    await request(app.getHttpServer()).post('/api/v1/calendar/sync').expect(201);
    const feed = await waitForSync(feedId, before.body.feeds[0].lastSyncAt);
    expect(feed.lastSyncStatus).toBe('error');
    expect(String(feed.lastSyncError)).toContain('connection reset');
    // The secret URL is not part of the error message.
    expect(String(feed.lastSyncError)).not.toContain('private-token-123');
    nextResponse = okResponse;

    // Events and links are still there.
    const itemEvents = await request(app.getHttpServer())
      .get(`/api/v1/calendar/items/${itemId}/events`)
      .expect(200);
    expect(itemEvents.body.events.length).toBeGreaterThan(0);
  });

  it('deleting the feed cascades events and links', async () => {
    await request(app.getHttpServer()).delete(`/api/v1/calendar/feeds/${feedId}`).expect(204);

    const feeds = await request(app.getHttpServer()).get('/api/v1/calendar/feeds').expect(200);
    expect(feeds.body.feeds).toHaveLength(0);

    const events = await request(app.getHttpServer())
      .get(`/api/v1/calendar/events?${rangeQuery()}`)
      .expect(200);
    expect(events.body.events).toHaveLength(0);

    const itemEvents = await request(app.getHttpServer())
      .get(`/api/v1/calendar/items/${itemId}/events`)
      .expect(200);
    expect(itemEvents.body.events).toHaveLength(0);
  });
});

import { mapGoogleEvent, GoogleCalendarClient, GOOGLE_OAUTH_CONFIG } from './google-calendar.client';
import { CALENDAR_FETCH, type FetchLike } from '../ics/ics-feed.client';
import { Test } from '@nestjs/testing';

const CONFIG = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app/cb' };

describe('mapGoogleEvent', () => {
  it('maps a timed event to UTC', () => {
    const ev = mapGoogleEvent({
      id: 'abc_20260101T100000Z',
      status: 'confirmed',
      summary: 'Standup',
      description: 'daily',
      location: 'Room 1',
      start: { dateTime: '2026-01-01T11:00:00+01:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-01-01T11:30:00+01:00', timeZone: 'Europe/Berlin' },
    });
    expect(ev).toEqual({
      externalUid: 'abc_20260101T100000Z',
      instanceStart: '2026-01-01T10:00:00.000Z',
      startAt: '2026-01-01T10:00:00.000Z',
      endAt: '2026-01-01T10:30:00.000Z',
      isAllDay: false,
      title: 'Standup',
      description: 'daily',
      location: 'Room 1',
      timezone: 'Europe/Berlin',
    });
  });

  it('maps an all-day event to UTC midnights', () => {
    const ev = mapGoogleEvent({
      id: 'holiday1',
      status: 'confirmed',
      summary: 'Holiday',
      start: { date: '2026-01-01' },
      end: { date: '2026-01-02' },
    });
    expect(ev).toMatchObject({
      isAllDay: true,
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-02T00:00:00.000Z',
      instanceStart: '2026-01-01T00:00:00.000Z',
      timezone: null,
    });
  });

  it('drops cancelled instances', () => {
    expect(mapGoogleEvent({ id: 'x', status: 'cancelled' })).toBeNull();
  });
});

describe('GoogleCalendarClient.listEvents', () => {
  it('follows nextPageToken and concatenates items', async () => {
    const pages: Record<string, unknown> = {
      first: { items: [{ id: 'a', status: 'confirmed', summary: 'A', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }], nextPageToken: 'p2' },
      p2: { items: [{ id: 'b', status: 'confirmed', summary: 'B', start: { date: '2026-01-03' }, end: { date: '2026-01-04' } }] },
    };
    const fetchMock: FetchLike = async (url) => {
      const token = new URL(String(url)).searchParams.get('pageToken') ?? 'first';
      return new Response(JSON.stringify(pages[token]), { status: 200 });
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoogleCalendarClient,
        { provide: CALENDAR_FETCH, useValue: fetchMock },
        { provide: GOOGLE_OAUTH_CONFIG, useValue: CONFIG },
      ],
    }).compile();
    const client = moduleRef.get(GoogleCalendarClient);
    const events = await client.listEvents('tok', 'primary', new Date('2026-01-01'), new Date('2026-02-01'));
    expect(events.map((e) => e.externalUid)).toEqual(['a', 'b']);
  });
});

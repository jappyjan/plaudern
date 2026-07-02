import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandIcsEvents, MAX_INSTANCES_PER_FEED } from './ics-parser';

function fixture(name: string): string {
  return readFileSync(join(__dirname, 'fixtures', name), 'utf8');
}

const WINDOW_START = new Date('2026-01-01T00:00:00.000Z');
const WINDOW_END = new Date('2026-12-31T00:00:00.000Z');

describe('expandIcsEvents', () => {
  it('parses a timed TZID event to UTC and reads the calendar name', () => {
    const { calendarName, events } = expandIcsEvents(
      fixture('simple.ics'),
      WINDOW_START,
      WINDOW_END,
    );
    expect(calendarName).toBe('Team Calendar');
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.externalUid).toBe('simple-1@test');
    // 15:00 Europe/Berlin on 2026-07-01 is CEST (UTC+2) → 13:00Z.
    expect(event.startAt).toBe('2026-07-01T13:00:00.000Z');
    expect(event.endAt).toBe('2026-07-01T14:00:00.000Z');
    expect(event.isAllDay).toBe(false);
    expect(event.title).toBe('Design review');
    expect(event.description).toBe('Quarterly design review');
    expect(event.location).toBe('Room 4');
    expect(event.instanceStart).toBe(event.startAt);
  });

  it('drops events outside the window', () => {
    const { events } = expandIcsEvents(fixture('simple.ics'), WINDOW_START, WINDOW_END);
    expect(events.some((event) => event.externalUid === 'far-future@test')).toBe(false);
  });

  it('normalizes all-day events to UTC calendar-date midnights with exclusive end', () => {
    const { events } = expandIcsEvents(fixture('allday.ics'), WINDOW_START, WINDOW_END);
    expect(events).toHaveLength(2);
    const single = events.find((event) => event.externalUid === 'allday-1@test');
    expect(single).toMatchObject({
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-07-02T00:00:00.000Z',
      isAllDay: true,
    });
    const multi = events.find((event) => event.externalUid === 'allday-2@test');
    expect(multi).toMatchObject({
      startAt: '2026-07-10T00:00:00.000Z',
      endAt: '2026-07-13T00:00:00.000Z',
      isAllDay: true,
    });
  });

  it('expands a TZID weekly series across a DST change, applying EXDATE and overrides', () => {
    const { events } = expandIcsEvents(fixture('recurring.ics'), WINDOW_START, WINDOW_END);
    const series = events
      .filter((event) => event.externalUid === 'weekly-1@test')
      .sort((a, b) => a.startAt.localeCompare(b.startAt));

    // COUNT=4 minus one EXDATE = 3 instances.
    expect(series).toHaveLength(3);

    // 2026-03-16 10:00 Berlin is CET (UTC+1) → 09:00Z.
    expect(series[0].startAt).toBe('2026-03-16T09:00:00.000Z');
    expect(series[0].endAt).toBe('2026-03-16T10:00:00.000Z');
    expect(series[0].instanceStart).toBe('2026-03-16T09:00:00.000Z');

    // 2026-03-23: overridden to 14:00 Berlin (13:00Z); identity keeps the
    // original occurrence start as instanceStart.
    expect(series[1].startAt).toBe('2026-03-23T13:00:00.000Z');
    expect(series[1].title).toBe('Weekly standup (moved)');
    expect(series[1].instanceStart).toBe('2026-03-23T09:00:00.000Z');

    // 2026-03-30 is after the March 29 DST switch: 10:00 Berlin is CEST → 08:00Z,
    // i.e. local wall-clock time is preserved across DST.
    expect(series[2].startAt).toBe('2026-03-30T08:00:00.000Z');
    expect(series[2].endAt).toBe('2026-03-30T09:00:00.000Z');

    // 2026-04-06 is EXDATE'd.
    expect(series.some((event) => event.startAt.startsWith('2026-04-06'))).toBe(false);
  });

  it('keeps UTC-anchored recurring events at fixed UTC times', () => {
    const { events } = expandIcsEvents(fixture('recurring.ics'), WINDOW_START, WINDOW_END);
    const series = events
      .filter((event) => event.externalUid === 'utc-weekly@test')
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    expect(series.map((event) => event.startAt)).toEqual([
      '2026-03-16T09:00:00.000Z',
      '2026-03-23T09:00:00.000Z',
      '2026-03-30T09:00:00.000Z',
    ]);
    expect(series.every((event) => event.endAt.endsWith('T09:30:00.000Z'))).toBe(true);
  });

  it('derives the end from DURATION and skips cancelled events', () => {
    const { events } = expandIcsEvents(fixture('special.ics'), WINDOW_START, WINDOW_END);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      externalUid: 'duration-1@test',
      startAt: '2026-07-01T09:00:00.000Z',
      endAt: '2026-07-01T09:45:00.000Z',
    });
  });

  it('caps expansion at MAX_INSTANCES_PER_FEED', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:daily-forever@test',
      'DTSTART:20200101T090000Z',
      'DTEND:20200101T093000Z',
      'RRULE:FREQ=HOURLY',
      'SUMMARY:Runaway',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\n');
    const { events, truncated } = expandIcsEvents(
      ics,
      new Date('2020-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
    );
    expect(truncated).toBe(true);
    expect(events).toHaveLength(MAX_INSTANCES_PER_FEED);
  });

  it('survives garbage input', () => {
    const { events } = expandIcsEvents('not an ics file', WINDOW_START, WINDOW_END);
    expect(events).toEqual([]);
  });
});

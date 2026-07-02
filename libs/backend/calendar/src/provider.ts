import type { CalendarProviderType } from '@plaudern/contracts';
import type { CalendarFeedEntity } from '@plaudern/persistence';

/**
 * A calendar event occurrence normalized for storage: recurring events are
 * expanded, all timestamps are ISO 8601 UTC. Identity across syncs is
 * (externalUid, instanceStart) within a feed.
 */
export interface NormalizedCalendarEvent {
  externalUid: string;
  /** Original occurrence start (RECURRENCE-ID for overrides), ISO UTC. */
  instanceStart: string;
  startAt: string;
  endAt: string;
  isAllDay: boolean;
  title: string | null;
  description: string | null;
  location: string | null;
  timezone: string | null;
}

export interface CalendarTestResult {
  ok: boolean;
  error: string | null;
  eventCount: number | null;
  calendarName: string | null;
}

/**
 * One implementation per provider type. `ics` is the only one today; an OAuth
 * provider (google, …) implements the same interface and registers itself in
 * the CALENDAR_PROVIDERS array.
 */
export interface CalendarProvider {
  readonly type: CalendarProviderType;
  fetchEvents(
    feed: CalendarFeedEntity,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<NormalizedCalendarEvent[]>;
  testConnection(rawUrl: string): Promise<CalendarTestResult>;
}

/** DI token for the array of registered providers. */
export const CALENDAR_PROVIDERS = Symbol('CALENDAR_PROVIDERS');

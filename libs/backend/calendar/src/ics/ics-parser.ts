import * as nodeIcal from 'node-ical';
import type { NormalizedCalendarEvent } from '../provider';

/** Hard cap on expanded instances per feed — a runaway RRULE must not explode the DB. */
export const MAX_INSTANCES_PER_FEED = 5000;

export interface ParsedCalendar {
  calendarName: string | null;
  events: NormalizedCalendarEvent[];
  /** True when MAX_INSTANCES_PER_FEED kicked in. */
  truncated: boolean;
}

type DateMaybeFlagged = Date & { tz?: string; dateOnly?: boolean };

/**
 * Parses an ICS body and expands every event (recurring ones included) into
 * concrete instances intersecting [windowStart, windowEnd].
 *
 * Timestamp semantics (all output is ISO 8601 UTC):
 * - Timed events: real instants; node-ical already resolves TZID/Z values.
 * - All-day events: node-ical parses DATE values to *server-local* midnight,
 *   so we re-anchor them to UTC midnight of the calendar date. DTEND is
 *   exclusive per RFC 5545 and stays exclusive in `endAt`.
 * - Recurring events: rrule returns real UTC instants when the series has a
 *   TZID (Luxon handles DST per occurrence) and for UTC-anchored series;
 *   floating series (no TZ at all) are re-anchored so the server-local
 *   wall-clock time stays constant across server DST changes.
 */
export function expandIcsEvents(
  icsText: string,
  windowStart: Date,
  windowEnd: Date,
): ParsedCalendar {
  const parsed = nodeIcal.sync.parseICS(icsText);
  let calendarName: string | null = null;
  const events: NormalizedCalendarEvent[] = [];
  let truncated = false;

  for (const component of Object.values(parsed)) {
    if (component.type === 'VCALENDAR') {
      calendarName = (component['WR-CALNAME'] as string | undefined) ?? calendarName;
    }
  }

  for (const component of Object.values(parsed)) {
    if (component.type !== 'VEVENT') continue;
    const vevent = component as nodeIcal.VEvent;
    if (!vevent.uid || !vevent.start) continue;
    if (vevent.status === 'CANCELLED' || vevent.method === 'CANCEL') continue;

    const remaining = MAX_INSTANCES_PER_FEED - events.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    if (vevent.rrule) {
      const { instances, hitCap } = expandRecurring(vevent, windowStart, windowEnd, remaining);
      events.push(...instances);
      truncated ||= hitCap;
    } else {
      const single = normalizeSingle(vevent);
      if (single && intersectsWindow(single, windowStart, windowEnd)) events.push(single);
    }
  }

  return { calendarName, events, truncated };
}

function intersectsWindow(
  event: NormalizedCalendarEvent,
  windowStart: Date,
  windowEnd: Date,
): boolean {
  return event.startAt <= windowEnd.toISOString() && event.endAt >= windowStart.toISOString();
}

function isAllDay(vevent: nodeIcal.VEvent): boolean {
  return vevent.datetype === 'date' || (vevent.start as DateMaybeFlagged).dateOnly === true;
}

/** UTC midnight of the *local* calendar date (node-ical parses DATE values as local midnight). */
function utcMidnightIso(date: Date): string {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString();
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeSingle(vevent: nodeIcal.VEvent): NormalizedCalendarEvent | null {
  const times = eventTimes(vevent);
  if (!times) return null;
  return buildEvent(vevent, times.startAt, times.endAt, times.allDay, times.startAt);
}

function eventTimes(
  vevent: nodeIcal.VEvent,
): { startAt: string; endAt: string; allDay: boolean } | null {
  const start = vevent.start as DateMaybeFlagged;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  const end = vevent.end instanceof Date && !Number.isNaN(vevent.end.getTime()) ? vevent.end : null;

  if (isAllDay(vevent)) {
    const startAt = utcMidnightIso(start);
    let endAt = end ? utcMidnightIso(end) : startAt;
    if (endAt <= startAt) endAt = new Date(Date.parse(startAt) + DAY_MS).toISOString();
    return { startAt, endAt, allDay: true };
  }

  const startAt = start.toISOString();
  const endAt = end && end.getTime() > start.getTime() ? end.toISOString() : startAt;
  return { startAt, endAt, allDay: false };
}

function buildEvent(
  vevent: nodeIcal.VEvent,
  startAt: string,
  endAt: string,
  allDay: boolean,
  instanceStart: string,
): NormalizedCalendarEvent {
  return {
    externalUid: vevent.uid,
    instanceStart,
    startAt,
    endAt,
    isAllDay: allDay,
    title: asTextOrNull(vevent.summary),
    description: asTextOrNull(vevent.description),
    location: asTextOrNull(vevent.location),
    timezone: (vevent.start as DateMaybeFlagged).tz ?? null,
  };
}

/** node-ical can yield string or {params, val} objects for text properties. */
function asTextOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object' && 'val' in value) {
    const val = (value as { val: unknown }).val;
    return typeof val === 'string' && val.length > 0 ? val : null;
  }
  return null;
}

function expandRecurring(
  vevent: nodeIcal.VEvent,
  windowStart: Date,
  windowEnd: Date,
  maxInstances: number,
): { instances: NormalizedCalendarEvent[]; hitCap: boolean } {
  const instances: NormalizedCalendarEvent[] = [];
  const rrule = vevent.rrule;
  const start = vevent.start as DateMaybeFlagged;
  if (!rrule || !(start instanceof Date)) return { instances, hitCap: false };

  const allDay = isAllDay(vevent);
  const durationMs =
    vevent.end instanceof Date ? Math.max(vevent.end.getTime() - start.getTime(), 0) : 0;

  // Search a little before the window so an occurrence that starts earlier
  // but overlaps into the window is still found.
  const searchStart = new Date(windowStart.getTime() - durationMs - DAY_MS);
  let occurrences: Date[];
  try {
    occurrences = rrule.between(searchStart, windowEnd, true);
  } catch {
    // A malformed RRULE must not kill the whole feed.
    return { instances, hitCap: false };
  }

  let hitCap = false;
  for (const occurrence of occurrences) {
    if (instances.length >= maxInstances) {
      hitCap = true;
      break;
    }
    const realStart = adjustOccurrence(occurrence, vevent);
    const dateKey = realStart.toISOString().slice(0, 10);

    // EXDATE'd occurrences are keyed by UTC date, same as node-ical stores them.
    if (vevent.exdate && (vevent.exdate as Record<string, unknown>)[dateKey]) continue;

    const override = vevent.recurrences?.[dateKey];
    if (override) {
      if (override.status === 'CANCELLED') continue;
      const times = eventTimes(override as nodeIcal.VEvent);
      if (!times) continue;
      const recurrenceId = (override as { recurrenceid?: Date }).recurrenceid;
      const instanceStart =
        recurrenceId instanceof Date ? recurrenceId.toISOString() : realStart.toISOString();
      const event = buildEvent(
        override as nodeIcal.VEvent,
        times.startAt,
        times.endAt,
        times.allDay,
        instanceStart,
      );
      // The override may be missing text fields — fall back to the series'.
      event.externalUid = vevent.uid;
      event.title ??= asTextOrNull(vevent.summary);
      event.description ??= asTextOrNull(vevent.description);
      event.location ??= asTextOrNull(vevent.location);
      if (intersectsWindow(event, windowStart, windowEnd)) instances.push(event);
      continue;
    }

    let startAt: string;
    let endAt: string;
    if (allDay) {
      startAt = utcMidnightIso(realStart);
      endAt =
        durationMs > 0
          ? new Date(Date.parse(startAt) + Math.ceil(durationMs / DAY_MS) * DAY_MS).toISOString()
          : new Date(Date.parse(startAt) + DAY_MS).toISOString();
    } else {
      startAt = realStart.toISOString();
      endAt = new Date(realStart.getTime() + durationMs).toISOString();
    }
    const event = buildEvent(vevent, startAt, endAt, allDay, startAt);
    if (intersectsWindow(event, windowStart, windowEnd)) instances.push(event);
  }

  return { instances, hitCap };
}

/**
 * Converts an rrule occurrence to a real UTC instant.
 * - Series with a TZID (node-ical also routes `...Z` starts here as Etc/UTC):
 *   rrule's rezonedDate() returns the real instant *shifted by the
 *   server-local UTC offset at the occurrence* — correct only on a UTC
 *   server. Adding getTimezoneOffset() back yields the real instant on any
 *   server, DST-correct per occurrence (equivalent to the node-ical README
 *   recipe, verified by the DST fixtures under multiple TZs).
 * - Floating series (no timezone at all): node-ical anchored DTSTART at the
 *   server-local wall time; re-apply the offset delta so the wall-clock time
 *   stays constant when the occurrence falls in a different server DST phase.
 */
function adjustOccurrence(occurrence: Date, vevent: nodeIcal.VEvent): Date {
  if (vevent.rrule?.origOptions.tzid) {
    return new Date(occurrence.getTime() + occurrence.getTimezoneOffset() * 60_000);
  }
  const offsetDeltaMin =
    (vevent.start as Date).getTimezoneOffset() - occurrence.getTimezoneOffset();
  return new Date(occurrence.getTime() - offsetDeltaMin * 60_000);
}

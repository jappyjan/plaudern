/**
 * Quiet-hours math. All windows are evaluated in the user's IANA timezone and
 * may wrap past midnight (start > end, e.g. 22:00 → 07:00). Kept as pure
 * functions so they're trivially unit-testable without a clock or a DB.
 */

/** Parse `HH:MM` into minutes since local midnight (0–1439). */
export function parseTimeOfDay(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`invalid time-of-day: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Minutes since local midnight for `date` as observed in `timeZone`. Falls back
 * to UTC minutes if the timezone is invalid (never throws — a bad tz must not
 * take down a dispatch).
 */
export function localMinutesInZone(date: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/**
 * Whether `now` (in `timeZone`) falls inside the [start, end) quiet window.
 * The window is inclusive of start and exclusive of end; an equal start/end is
 * treated as "never quiet".
 */
export function isWithinQuietHours(
  now: Date,
  timeZone: string,
  start: string,
  end: string,
): boolean {
  const startMin = parseTimeOfDay(start);
  const endMin = parseTimeOfDay(end);
  if (startMin === endMin) return false;
  const cur = localMinutesInZone(now, timeZone);
  if (startMin < endMin) return cur >= startMin && cur < endMin;
  // Overnight wrap: quiet if after start OR before end.
  return cur >= startMin || cur < endMin;
}

/**
 * The next instant `now` reaches the quiet-window end time in `timeZone` — a
 * retry hint for callers that want to defer rather than drop a notification.
 */
export function quietHoursEndsAt(now: Date, timeZone: string, end: string): Date {
  const endMin = parseTimeOfDay(end);
  const cur = localMinutesInZone(now, timeZone);
  let delta = endMin - cur;
  if (delta <= 0) delta += 24 * 60;
  return new Date(now.getTime() + delta * 60_000);
}

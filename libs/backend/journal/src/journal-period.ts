import type { JournalPeriodType } from '@plaudern/contracts';

/**
 * Pure period math for the auto-journal (JJ-17). Everything is computed in UTC,
 * matching how inbox `occurredAt` and calendar times are stored (ISO 8601 UTC
 * strings), so period keys and ranges are deterministic and driver-independent.
 *
 * Keys:
 *   day   → `YYYY-MM-DD`
 *   week  → `YYYY-Www` (ISO-8601 week; week 1 is the week with the year's first
 *            Thursday, weeks start Monday)
 *   month → `YYYY-MM`
 *   year  → `YYYY`
 */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function asDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** `YYYY-MM-DD` (UTC) for a timestamp. */
export function dayKeyOf(value: string | Date): string {
  const d = asDate(value);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** ISO-8601 {year, week} for a timestamp (Mon-based, Thursday rule). */
function isoWeekParts(value: string | Date): { year: number; week: number } {
  const src = asDate(value);
  // Work on the date's UTC midnight so time-of-day never shifts the week.
  const date = new Date(Date.UTC(src.getUTCFullYear(), src.getUTCMonth(), src.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  // Shift to the Thursday of this week — its calendar year owns the week number.
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: date.getUTCFullYear(), week };
}

/** `YYYY-Www` (UTC ISO week) for a timestamp. */
export function weekKeyOf(value: string | Date): string {
  const { year, week } = isoWeekParts(value);
  return `${year}-W${pad2(week)}`;
}

/** `YYYY-MM` (UTC) for a timestamp. */
export function monthKeyOf(value: string | Date): string {
  const d = asDate(value);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** `YYYY` (UTC) for a timestamp. */
export function yearKeyOf(value: string | Date): string {
  return String(asDate(value).getUTCFullYear());
}

/** The rollup key a day belongs to for a coarser granularity. */
export function parentKeyOfDay(dayKey: string, parent: Exclude<JournalPeriodType, 'day'>): string {
  const day = `${dayKey}T00:00:00.000Z`;
  if (parent === 'week') return weekKeyOf(day);
  if (parent === 'month') return monthKeyOf(day);
  return yearKeyOf(day);
}

/** The Monday (UTC midnight) that opens the given ISO week. */
function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const mondayWeek1 = new Date(jan4);
  mondayWeek1.setUTCDate(jan4.getUTCDate() - jan4DayNum);
  const monday = new Date(mondayWeek1);
  monday.setUTCDate(mondayWeek1.getUTCDate() + (week - 1) * 7);
  return monday;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_KEY_RE = /^\d{4}-W\d{2}$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const YEAR_KEY_RE = /^\d{4}$/;

/** Whether a key is well-formed for its granularity (rejects garbage from the URL). */
export function isValidPeriodKey(periodType: JournalPeriodType, periodKey: string): boolean {
  switch (periodType) {
    case 'day':
      return DAY_KEY_RE.test(periodKey) && !Number.isNaN(Date.parse(`${periodKey}T00:00:00Z`));
    case 'week':
      return WEEK_KEY_RE.test(periodKey);
    case 'month':
      return MONTH_KEY_RE.test(periodKey);
    case 'year':
      return YEAR_KEY_RE.test(periodKey);
  }
}

/**
 * The half-open UTC range [start, endExclusive) a period covers, as ISO
 * strings. Callers query signals with `>= start AND < endExclusive`.
 */
export function periodRange(
  periodType: JournalPeriodType,
  periodKey: string,
): { startIso: string; endExclusiveIso: string } {
  let start: Date;
  let end: Date;
  if (periodType === 'day') {
    const [y, m, d] = periodKey.split('-').map(Number);
    start = new Date(Date.UTC(y, m - 1, d));
    end = new Date(Date.UTC(y, m - 1, d + 1));
  } else if (periodType === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    start = new Date(Date.UTC(y, m - 1, 1));
    end = new Date(Date.UTC(y, m, 1));
  } else if (periodType === 'year') {
    const y = Number(periodKey);
    start = new Date(Date.UTC(y, 0, 1));
    end = new Date(Date.UTC(y + 1, 0, 1));
  } else {
    const [yStr, wStr] = periodKey.split('-W');
    start = mondayOfIsoWeek(Number(yStr), Number(wStr));
    end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
  }
  return { startIso: start.toISOString(), endExclusiveIso: end.toISOString() };
}

/** Whether a period is entirely in the past relative to `now` (default: now). */
export function periodHasEnded(
  periodType: JournalPeriodType,
  periodKey: string,
  now: Date = new Date(),
): boolean {
  return Date.parse(periodRange(periodType, periodKey).endExclusiveIso) <= now.getTime();
}

/** The coarser granularities a rollup can compose (day is the leaf). */
export const ROLLUP_TYPES: Array<Exclude<JournalPeriodType, 'day'>> = ['week', 'month', 'year'];

/**
 * The granularity a rollup composes FROM. Weekly and monthly reviews compose
 * from the daily entries; a yearly review composes from the MONTHLY reviews
 * (hierarchical), so a "Your 2026" covers all twelve months instead of
 * truncating to the ~60 most-recent days. This keeps every level's source count
 * well under the generation cap while covering the whole span.
 */
export function childTypeOf(rollupType: Exclude<JournalPeriodType, 'day'>): JournalPeriodType {
  return rollupType === 'year' ? 'month' : 'day';
}

/**
 * The rollup key a child entry rolls up into. For a week/month the child is a
 * day key (`YYYY-MM-DD`); for a year the child is a month key (`YYYY-MM`).
 */
export function rollupKeyOfChild(
  rollupType: Exclude<JournalPeriodType, 'day'>,
  childKey: string,
): string {
  if (rollupType === 'year') return childKey.slice(0, 4); // childKey is a month
  return parentKeyOfDay(childKey, rollupType); // childKey is a day
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A human label for a period key, for the generation prompt (UTC-based). */
export function periodLabel(periodType: JournalPeriodType, periodKey: string): string {
  if (periodType === 'day') {
    const d = new Date(`${periodKey}T00:00:00.000Z`);
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });
  }
  if (periodType === 'month') {
    const [y, m] = periodKey.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
  }
  if (periodType === 'year') return periodKey;
  const [y, w] = periodKey.split('-W');
  return `Week ${Number(w)}, ${y}`;
}

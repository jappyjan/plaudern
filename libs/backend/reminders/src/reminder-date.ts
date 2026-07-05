/**
 * Resolve a model-supplied date expression into an absolute FUTURE instant,
 * anchored to the SOURCE recording's timestamp — never "now" (JJ-25). A
 * recording processed weeks after it was made must still land "next month" on
 * the month after the recording, and "the 14th" on the 14th following the day
 * it was spoken.
 *
 * All arithmetic is done in UTC so the result is deterministic regardless of
 * server timezone (the spec relies on this). Returns an ISO string for the
 * resolved instant, or `null` when the expression can't be resolved to a date
 * at or after the recording day — the caller SKIPS such entries rather than
 * storing a bogus or past reminder, so an unparseable date never crashes the
 * extractor.
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** UTC midnight of the day `date` falls on. */
function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Days in a given UTC month (0-based month), handling leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Add whole months in UTC, clamping the day to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonthAbs = month + months;
  const targetYear = year + Math.floor(targetMonthAbs / 12);
  const targetMonth = ((targetMonthAbs % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return new Date(Date.UTC(targetYear, targetMonth, clampedDay));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * Resolve `phrase` against `occurredAtIso`. Returns an ISO instant at or after
 * the recording's day, or null when nothing parses / the date is in the past.
 */
export function resolveDueAt(phrase: string, occurredAtIso: string): string | null {
  const ref = new Date(occurredAtIso);
  if (Number.isNaN(ref.getTime())) return null;
  const raw = phrase.trim();
  if (!raw) return null;
  const refDay = startOfUtcDay(ref);

  const candidate = parsePhrase(raw, ref, refDay);
  if (!candidate || Number.isNaN(candidate.getTime())) return null;
  // Prospective only: a date before the recording day isn't a future reminder.
  if (candidate.getTime() < refDay.getTime()) return null;
  return candidate.toISOString();
}

function parsePhrase(raw: string, ref: Date, refDay: Date): Date | null {
  // 1) Absolute ISO / slash dates: "2026-08-14", "2026-08-14T17:00:00Z",
  //    "2026/08/14". A bare date is treated as UTC midnight of that day.
  const iso = raw.match(/\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/i);
  if (iso) {
    const [, y, mo, d, hh, mm, ss] = iso;
    const date = new Date(
      Date.UTC(
        Number(y),
        Number(mo) - 1,
        Number(d),
        hh ? Number(hh) : 0,
        mm ? Number(mm) : 0,
        ss ? Number(ss) : 0,
      ),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const p = raw.toLowerCase();

  // 2) Fixed relative keywords.
  if (/\bday after tomorrow\b/.test(p)) return addDays(refDay, 2);
  if (/\btomorrow\b/.test(p)) return addDays(refDay, 1);
  if (/\b(today|tonight|this evening|this afternoon)\b/.test(p)) return refDay;
  if (/\bnext year\b/.test(p) || /\bin a year\b/.test(p)) return addMonths(refDay, 12);
  if (/\bnext month\b/.test(p) || /\bin a month\b/.test(p)) return addMonths(refDay, 1);
  if (/\b(next week|in a week)\b/.test(p)) return addDays(refDay, 7);

  // 3) "in N days/weeks/months/years" (also "N days from now / later").
  const inN = p.match(/\bin\s+(\d{1,3})\s+(day|week|month|year)s?\b/);
  const nFrom = p.match(/\b(\d{1,3})\s+(day|week|month|year)s?\s+(?:from now|later|out)\b/);
  const rel = inN ?? nFrom;
  if (rel) {
    const n = Number(rel[1]);
    switch (rel[2]) {
      case 'day':
        return addDays(refDay, n);
      case 'week':
        return addDays(refDay, n * 7);
      case 'month':
        return addMonths(refDay, n);
      case 'year':
        return addMonths(refDay, n * 12);
    }
  }

  // 4) Month name + day (+ optional year): "August 14", "14 August 2027",
  //    "Aug 14th". Without a year, roll to next year if the date already passed.
  // Longest month names first so "august" wins over "aug"; `(?!\d)` after the
  // day stops it swallowing the leading digits of a 4-digit year ("14 August
  // 2027" must read day=14, not day=20 from "2027").
  const monthNames = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const mdyRe = new RegExp(`\\b(${monthNames})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`);
  const dmyRe = new RegExp(`\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\.?(?:,?\\s+(\\d{4}))?\\b`);
  const md = p.match(mdyRe);
  const dm = p.match(dmyRe);
  if (md || dm) {
    const monthKey = (md ? md[1] : dm![2]) as string;
    const day = Number(md ? md[2] : dm![1]);
    const yearStr = md ? md[3] : dm![3];
    const month = MONTHS[monthKey];
    if (month !== undefined && day >= 1 && day <= 31) {
      const year = yearStr ? Number(yearStr) : ref.getUTCFullYear();
      let date = new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))));
      if (!yearStr && date.getTime() < refDay.getTime()) {
        date = new Date(Date.UTC(year + 1, month, Math.min(day, daysInMonth(year + 1, month))));
      }
      return date;
    }
  }

  // 5) Weekday: "next Friday", "on Monday", "friday". Next occurrence at or
  //    after the recording day; "next" forces the following week for same-day.
  const wd = p.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/);
  if (wd) {
    const target = WEEKDAYS[wd[2]];
    let ahead = (target - refDay.getUTCDay() + 7) % 7;
    if (ahead === 0 && wd[1]) ahead = 7;
    return addDays(refDay, ahead);
  }

  // 6) Bare day-of-month: "the 14th", "on the 1st", "by the 22nd". The next
  //    occurrence of that day at or after the recording day (roll to next month
  //    when it already passed).
  const dom = p.match(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/);
  if (dom) {
    const day = Number(dom[1]);
    if (day >= 1 && day <= 31) {
      const year = ref.getUTCFullYear();
      const month = ref.getUTCMonth();
      let date = new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))));
      if (date.getTime() < refDay.getTime()) date = addMonths(date, 1);
      return date;
    }
  }

  return null;
}

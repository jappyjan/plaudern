/**
 * Resolve the date PRINTED ON a scanned document (invoice/letter/statement date)
 * into an absolute ISO instant. Unlike the reminders resolver
 * (`libs/backend/reminders/src/reminder-date.ts`), this is for HISTORICAL dates:
 * there is no "must be in the future" guard and no relative-future keywords
 * ("next month", "in 2 weeks") — a document's date is whatever is written on it.
 *
 * We only accept unambiguous ABSOLUTE forms, because the resolved value is used
 * as the item's displayed date and must be a real datetime (a bare "the 14th"
 * has no meaning on an old letter). Returns an ISO string at UTC midnight of the
 * parsed day, or `null` when nothing absolute parses — the caller stores null
 * and falls back to the item's capture time.
 *
 * All arithmetic is done in UTC so the result is deterministic regardless of
 * server timezone.
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
  // Common German month names (documents may be in German).
  januar: 0, februar: 1, märz: 2, maerz: 2, mai: 4, juni: 5, juli: 6,
  oktober: 9, dezember: 11,
};

/** Days in a given UTC month (0-based month), handling leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Build a UTC-midnight Date, validating the day against the month, or null. */
function utcDate(year: number, month: number, day: number): string | null {
  if (month < 0 || month > 11) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  const date = new Date(Date.UTC(year, month, day));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Resolve `phrase` (a document date the model returned, ideally already
 * `YYYY-MM-DD`) against `anchorIso` (the scan time, used only to expand a
 * 2-digit year). Returns an absolute ISO instant, or null when nothing parses.
 */
export function resolveDocumentDate(
  phrase: string | null | undefined,
  anchorIso: string,
): string | null {
  if (!phrase) return null;
  const raw = phrase.trim();
  if (!raw) return null;
  const anchor = new Date(anchorIso);
  const anchorYear = Number.isNaN(anchor.getTime())
    ? new Date().getUTCFullYear()
    : anchor.getUTCFullYear();

  // 1) ISO / slash: "2026-08-14", "2026/08/14", optionally with a time.
  const iso = raw.match(
    /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[t ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/i,
  );
  if (iso) {
    const [, y, mo, d] = iso;
    return utcDate(Number(y), Number(mo) - 1, Number(d));
  }

  // 2) Day-first with separators: "14.08.2026" (German), "14/08/2026",
  //    "14-08-2026", "14.8.26". Day and month first, year last; 2-digit years
  //    expand to the century of the scan date.
  const dmy = raw.match(/\b(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})\b/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]) - 1;
    const year = expandYear(Number(dmy[3]), anchorYear);
    return utcDate(year, month, day);
  }

  const p = raw.toLowerCase();
  const monthNames = Object.keys(MONTHS)
    .sort((a, b) => b.length - a.length)
    .join('|');

  // 3) Month name + day + YEAR (year required — no rolling for historical dates):
  //    "August 14, 2026", "14 August 2026", "14. August 2026".
  const mdyRe = new RegExp(
    `\\b(${monthNames})\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`,
  );
  const dmyNameRe = new RegExp(
    `\\b(\\d{1,2})\\.?(?!\\d)(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\.?,?\\s+(\\d{4})\\b`,
  );
  const md = p.match(mdyRe);
  const dm = p.match(dmyNameRe);
  if (md || dm) {
    const monthKey = (md ? md[1] : dm![2]) as string;
    const day = Number(md ? md[2] : dm![1]);
    const year = Number(md ? md[3] : dm![3]);
    const month = MONTHS[monthKey];
    if (month !== undefined) return utcDate(year, month, day);
  }

  return null;
}

/** Expand a possibly 2-digit year to the century of the anchor year. */
function expandYear(year: number, anchorYear: number): number {
  if (year >= 100) return year;
  const century = Math.floor(anchorYear / 100) * 100;
  const candidate = century + year;
  // If that lands more than 50 years in the future of the anchor, it was the
  // previous century (e.g. anchor 2026, "98" → 1998, not 2098).
  return candidate > anchorYear + 50 ? candidate - 100 : candidate;
}

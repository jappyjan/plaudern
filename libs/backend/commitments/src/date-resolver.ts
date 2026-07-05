/**
 * Resolve a promissory time expression ("by Friday", "bis Freitag", "next
 * week", "in 3 Tagen", "2026-07-10") to an absolute instant, anchored on the
 * recording time (`occurredAt`). This is the "relative dates resolved from
 * occurredAt" step of the commitments extractor (JJ-36) — the extractor stores
 * the ABSOLUTE result so the read model never has to re-interpret language at
 * query time. English AND German tokens are understood, since recordings mix
 * both.
 *
 * Deliberately conservative: only well-understood expressions resolve; anything
 * ambiguous returns null (an open commitment with no due date) rather than a
 * guessed instant. All arithmetic is in UTC to stay deterministic across the
 * Postgres/sqlite drivers and server timezones.
 */

const WEEKDAYS: Record<string, number> = {
  // English
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  // German
  sonntag: 0,
  montag: 1,
  dienstag: 2,
  mittwoch: 3,
  donnerstag: 4,
  freitag: 5,
  samstag: 6,
  sonnabend: 6,
};

/** Resolved due dates land at 17:00 UTC — a neutral "end of business" instant. */
const DUE_HOUR_UTC = 17;

/**
 * @param phrase the raw time expression from the model (or null)
 * @param anchorIso the recording time (ISO) used as "now" for relative phrases
 * @returns an ISO instant, or null when nothing resolvable was found
 */
export function resolveDueDate(
  phrase: string | null | undefined,
  anchorIso: string | null | undefined,
): string | null {
  if (!phrase || !anchorIso) return null;
  const anchor = new Date(anchorIso);
  if (Number.isNaN(anchor.getTime())) return null;

  const lowered = phrase.toLowerCase().trim().replace(/[.!?]+$/g, '').trim();

  // Absolute ISO / parseable date wins outright (e.g. the model already
  // normalized it). Guard against Date.parse's looseness by requiring at least
  // a year-month-day shape.
  if (/^\d{4}-\d{2}-\d{2}/.test(phrase.trim())) {
    const parsed = new Date(phrase.trim());
    if (!Number.isNaN(parsed.getTime())) return atDueHour(parsed);
  }

  // "end of (the) week/month" (EN) / "Ende der Woche / des Monats" (DE) must
  // be recognized BEFORE generic filler stripping, otherwise they would
  // collapse to a bare "week"/"month".
  if (/\bend of (the )?week\b/.test(lowered) || /\bende (der|dieser) woche\b/.test(lowered)) {
    return atDueHour(nextWeekday(anchor, 5, false)); // upcoming Friday
  }
  if (
    /\bend of (the )?month\b/.test(lowered) ||
    /\bende (des|dieses) monats\b/.test(lowered) ||
    /\bmonatsende\b/.test(lowered)
  ) {
    return atDueHour(endOfMonth(anchor));
  }

  // Drop leading promissory prepositions/articles (EN + DE) so "by Friday" /
  // "bis zum Freitag" / "am Montag" / "spätestens Freitag" match; loop until
  // stable since several may stack ("by the Friday", "bis zum Freitag").
  let text = lowered;
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(
        /^(by|before|on|due|until|till|no later than|the|bis|zum|zur|am|vor|spätestens|spaetestens|diesen|diesem|dieser|dieses)\s+/,
        '',
      )
      .trim();
  } while (text !== previous);
  if (!text) return null;

  if (
    text === 'today' ||
    text === 'tonight' ||
    text === 'this evening' ||
    text === 'heute' ||
    text === 'heute abend'
  ) {
    return atDueHour(addDays(anchor, 0));
  }
  if (text === 'tomorrow' || text === 'morgen') return atDueHour(addDays(anchor, 1));
  if (
    text === 'day after tomorrow' ||
    text === 'overmorrow' ||
    text === 'übermorgen' ||
    text === 'uebermorgen'
  ) {
    return atDueHour(addDays(anchor, 2));
  }
  if (
    text === 'week' ||
    text === 'next week' ||
    /^(nächste|naechste|kommende) woche$/.test(text)
  ) {
    return atDueHour(addDays(anchor, 7));
  }
  if (
    text === 'month' ||
    text === 'next month' ||
    /^(nächsten|nächster|naechsten|naechster|kommenden) monat$/.test(text)
  ) {
    return atDueHour(addMonths(anchor, 1));
  }
  if (text === 'weekend' || text === 'this weekend' || text === 'wochenende') {
    return atDueHour(nextWeekday(anchor, 6, false));
  }

  // "in N day(s)/week(s)/month(s)" (EN) / "in N Tagen/Wochen/Monaten" (DE).
  const relative = text.match(
    /^in\s+(\d+)\s+(day|days|week|weeks|month|months|tag|tagen|woche|wochen|monat|monaten)$/,
  );
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    if (unit.startsWith('day') || unit.startsWith('tag')) return atDueHour(addDays(anchor, n));
    if (unit.startsWith('week') || unit.startsWith('woche')) {
      return atDueHour(addDays(anchor, n * 7));
    }
    return atDueHour(addMonths(anchor, n));
  }

  // Weekday name, optionally "next monday" / "nächsten Montag" (jump to the
  // following week).
  const weekdayMatch = text.match(
    /^((?:next|nächsten|nächste|naechsten|naechste|kommenden|kommende)\s+)?([a-zäöüß]+)$/,
  );
  if (weekdayMatch) {
    const forceNext = Boolean(weekdayMatch[1]);
    const target = WEEKDAYS[weekdayMatch[2]];
    if (target !== undefined) return atDueHour(nextWeekday(anchor, target, forceNext));
  }

  return null;
}

/** The next occurrence of `target` weekday strictly after the anchor day. */
function nextWeekday(anchor: Date, target: number, forceNextWeek: boolean): Date {
  const current = anchor.getUTCDay();
  let delta = (target - current + 7) % 7;
  // Same weekday as the anchor → jump a full week so a due date is never "now".
  if (delta === 0) delta = 7;
  if (forceNextWeek && delta < 7) delta += 7;
  return addDays(anchor, delta);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function endOfMonth(date: Date): Date {
  const d = new Date(date.getTime());
  // Day 0 of the next month is the last day of this one.
  d.setUTCMonth(d.getUTCMonth() + 1, 0);
  return d;
}

/** Pin a resolved calendar day to the canonical 17:00 UTC due instant. */
function atDueHour(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), DUE_HOUR_UTC, 0, 0),
  );
  return d.toISOString();
}

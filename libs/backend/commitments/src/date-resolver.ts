/**
 * Resolve a promissory time expression ("by Friday", "next week", "in 3 days",
 * "2026-07-10") to an absolute instant, anchored on the recording time
 * (`occurredAt`). This is the "relative dates resolved from occurredAt" step of
 * the commitments extractor (JJ-36) — the extractor stores the ABSOLUTE result
 * so the read model never has to re-interpret language at query time.
 *
 * Deliberately conservative: only well-understood expressions resolve; anything
 * ambiguous returns null (an open commitment with no due date) rather than a
 * guessed instant. All arithmetic is in UTC to stay deterministic across the
 * Postgres/sqlite drivers and server timezones.
 */

const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
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

  // "end of (the) week/month" must be recognized BEFORE generic filler
  // stripping, otherwise it would collapse to a bare "week"/"month".
  if (/\bend of (the )?week\b/.test(lowered)) {
    return atDueHour(nextWeekday(anchor, 5, false)); // upcoming Friday
  }
  if (/\bend of (the )?month\b/.test(lowered)) {
    return atDueHour(endOfMonth(anchor));
  }

  // Drop leading promissory prepositions/articles so "by Friday"/"on the
  // Monday" match; loop until stable since several may stack ("by the Friday").
  let text = lowered;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/^(by|before|on|due|until|till|no later than|the)\s+/, '').trim();
  } while (text !== previous);
  if (!text) return null;

  if (text === 'today' || text === 'tonight' || text === 'this evening') {
    return atDueHour(addDays(anchor, 0));
  }
  if (text === 'tomorrow') return atDueHour(addDays(anchor, 1));
  if (text === 'day after tomorrow' || text === 'overmorrow') {
    return atDueHour(addDays(anchor, 2));
  }
  if (text === 'week' || text === 'next week') return atDueHour(addDays(anchor, 7));
  if (text === 'month' || text === 'next month') return atDueHour(addMonths(anchor, 1));
  if (text === 'weekend' || text === 'this weekend') {
    return atDueHour(nextWeekday(anchor, 6, false));
  }

  // "in N day(s)/week(s)/month(s)".
  const relative = text.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2];
    if (unit.startsWith('day')) return atDueHour(addDays(anchor, n));
    if (unit.startsWith('week')) return atDueHour(addDays(anchor, n * 7));
    return atDueHour(addMonths(anchor, n));
  }

  // Weekday name, optionally "next monday" (jump to the following week).
  const weekdayMatch = text.match(/^(next\s+)?(\w+)$/);
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

import type { CommitmentDirection, NudgeReason } from '@plaudern/contracts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far ahead of a due date an `owed_by_me` promise starts nudging ("it's
 * Thursday and the draft is due Friday"). Overdue commitments always nudge.
 */
export const NUDGE_LEAD_DAYS = 2;

/**
 * When a commitment carries NO resolvable due date, how old the promise must be
 * (measured from the recording it was made in) before it's treated as stale and
 * worth surfacing ("Tom promised the answer two weeks ago").
 */
export const NUDGE_STALE_DAYS = 14;

/** The lowercased text of one recording later than the commitment. */
export interface LaterItemText {
  occurredAt: string;
  /** transcription + summary text, already lowercased. */
  text: string;
}

export type NudgeEligibility =
  | { eligible: false }
  | { eligible: true; reason: NudgeReason };

/**
 * Decide whether a commitment is worth nudging on, purely from its timing.
 *  - a resolvable due date drives `overdue` (past) / `due_soon` (within the lead
 *    window); a due date further out is not yet nudge-worthy,
 *  - with no resolvable due date, the promise nudges once it's older than the
 *    stale window (`stale`).
 * Direction is irrelevant to timing — it only changes the framing/draft — so
 * both directions share this rule.
 */
export function classifyNudge(params: {
  dueDate: string | null;
  occurredAt: string;
  now: number;
}): NudgeEligibility {
  const { dueDate, occurredAt, now } = params;
  if (dueDate) {
    const due = Date.parse(dueDate);
    if (!Number.isNaN(due)) {
      if (due < now) return { eligible: true, reason: 'overdue' };
      if (due <= now + NUDGE_LEAD_DAYS * DAY_MS) return { eligible: true, reason: 'due_soon' };
      return { eligible: false };
    }
  }
  const occurred = Date.parse(occurredAt);
  if (!Number.isNaN(occurred) && occurred <= now - NUDGE_STALE_DAYS * DAY_MS) {
    return { eligible: true, reason: 'stale' };
  }
  return { eligible: false };
}

/** Lowercased/whitespace-collapsed key — matches the commitments normalizer. */
export function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Common function words (English + German) stripped before comparing a
 * commitment's subject against later recordings, so a match is driven by the
 * DISTINCTIVE words of the promise ("draft", "landlord") rather than filler.
 */
const STOPWORDS = new Set([
  // English
  'about', 'after', 'again', 'back', 'been', 'before', 'being', 'both', 'could',
  'does', 'doing', 'done', 'from', 'gave', 'give', 'gonna', 'going', 'have',
  'here', 'into', 'just', 'like', 'make', 'more', 'need', 'over', 'said', 'same',
  'send', 'sent', 'she', 'some', 'soon', 'sure', 'take', 'tell', 'that', 'them',
  'then', 'there', 'they', 'thing', 'this', 'told', 'until', 'want', 'well',
  'went', 'were', 'what', 'when', 'will', 'with', 'would', 'your', 'youll',
  'youre', 'their',
  // German
  'aber', 'auch', 'dann', 'dass', 'dein', 'dich', 'diese', 'doch', 'eine',
  'einen', 'euch', 'habe', 'haben', 'hier', 'ihre', 'kann', 'mehr', 'mein',
  'nach', 'nicht', 'noch', 'oder', 'schon', 'sein', 'sind', 'über', 'und',
  'uns', 'unser', 'vom', 'von', 'wenn', 'werde', 'werden', 'wird', 'wollte',
  'würde',
]);

/**
 * The distinctive subject words of a commitment: length ≥ 4, de-duplicated, with
 * function words removed. These are what we look for in later recordings.
 */
export function subjectKeywords(description: string): string[] {
  const words = normalize(description)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * Deterministic follow-up / resolution detection (JJ-26, the KEY step): before
 * nudging, scan STRICTLY LATER recordings for evidence the commitment was
 * already handled — e.g. a later note that mentions the counterparty AND enough
 * of the promise's distinctive subject words ("I sent Anna the draft").
 *
 * The bias is deliberately toward NOT declaring resolution (requiring the
 * counterparty and/or a strong subject overlap): a false "resolved" silently
 * suppresses a nudge the user needed, which is worse than an occasional nudge on
 * something already done. When the description carries no distinctive words we
 * can't judge and never suppress.
 */
export function isResolvedByLaterItems(params: {
  description: string;
  counterpartyName: string | null;
  occurredAt: string;
  laterTexts: LaterItemText[];
}): boolean {
  const keywords = subjectKeywords(params.description);
  if (keywords.length === 0) return false;
  const counterparty = params.counterpartyName ? normalize(params.counterpartyName) : null;
  const anchor = Date.parse(params.occurredAt);

  for (const item of params.laterTexts) {
    const at = Date.parse(item.occurredAt);
    if (Number.isNaN(at) || Number.isNaN(anchor) || at <= anchor) continue;
    const text = item.text;
    const hits = keywords.reduce((n, k) => (text.includes(k) ? n + 1 : n), 0);
    if (hits === 0) continue;
    const ratio = hits / keywords.length;

    if (counterparty) {
      // Either the counterparty is named alongside some subject overlap, or the
      // subject overlap on its own is very strong.
      const counterpartyNamed = text.includes(counterparty);
      if ((counterpartyNamed && ratio >= 0.5) || (hits >= 2 && ratio >= 0.8)) return true;
    } else if (hits >= 2 && ratio >= 0.6) {
      return true;
    }
  }
  return false;
}

/**
 * A ready-to-send follow-up message, templated by direction — the "want a nudge
 * text drafted?" affordance, produced deterministically (no LLM call).
 */
export function draftNudgeText(
  direction: CommitmentDirection,
  counterpartyName: string | null,
  description: string,
): string {
  const desc = description.trim().replace(/[.!?]+$/, '');
  const who = counterpartyName?.trim() || null;
  if (direction === 'owed_by_me') {
    return who
      ? `Hi ${who}, following up on my end — I still owe you: ${desc}. I'll get it over to you shortly.`
      : `Note to self: you still owe — ${desc}. Close the loop.`;
  }
  return who
    ? `Hi ${who}, gentle nudge on ${desc} — any update on that?`
    : `Following up on ${desc} — any update on that?`;
}

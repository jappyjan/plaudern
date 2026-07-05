import type { OpenLoopDto, OpenLoopKind, OpenLoopState } from '@plaudern/contracts';

/**
 * DI token for the set of ledger sources (multi-provider). Each source adapts
 * one extraction kind (tasks, commitments, later questions) into the normalized
 * `OpenLoopDto` and knows how to advance one of its rows. `OpenLoopsService`
 * fans out over every bound source, so adding a kind is: implement this
 * interface, bind it into this array in `OpenLoopsModule`. No change to the
 * service, controller, or contract is required — this is the extension point
 * JJ-34 (open questions) plugs into.
 */
export const OPEN_LOOP_SOURCES = Symbol('OPEN_LOOP_SOURCES');

/** A pluggable ledger source: one extraction kind, adapted to the unified row. */
export interface OpenLoopSource {
  /** The kind this source owns; `updateState` is routed to it by this value. */
  readonly kind: OpenLoopKind;
  /**
   * The user's loops from this source. `includeResolved=false` (the default)
   * returns only unresolved (`open`) loops; `true` also returns done/dropped.
   * Scores are NOT set here — `OpenLoopsService` ranks the merged list.
   */
  list(userId: string, includeResolved: boolean): Promise<OpenLoopDto[]>;
  /**
   * Advance one of this source's rows to `state`, delegating to the source's own
   * mutation so durability against re-extraction is inherited. Returns the
   * refreshed (unscored) loop. Throws NotFound when the id is not this user's.
   */
  updateState(userId: string, id: string, state: OpenLoopState): Promise<OpenLoopDto>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Overdue loops jump the queue by this flat amount (in "age-day" units). */
const OVERDUE_BOOST = 40;
/** Extra per-day urgency the longer a loop stays overdue, capped. */
const OVERDUE_PER_DAY_CAP = 60;
/** A loop due within this many days gets a soft, shrinking boost. */
const DUE_SOON_WINDOW_DAYS = 7;
const DUE_SOON_BOOST = 20;
/** Each recording beyond the first that raised the loop adds this. */
const REPEAT_MENTION_WEIGHT = 3;

/**
 * Rank an open loop: higher score surfaces first. The score composes AGE and
 * IMPORTANCE (the ticket's ranking axes):
 *  - age: days since it opened — silently-dropped loops fester, so the oldest
 *    float up on their own,
 *  - overdue: a flat jump plus a per-day-late ramp so nothing overdue is buried
 *    under merely old loops,
 *  - due-soon: a shrinking nudge as the due date approaches,
 *  - repeat mentions: loops raised across many recordings matter more.
 *
 * Deterministic and side-effect free so the value is stable per request and the
 * client can re-sort without a round-trip.
 */
export function scoreOpenLoop(loop: OpenLoopDto, now: number): number {
  const ageDays = Math.max(0, (now - Date.parse(loop.firstSeenAt)) / DAY_MS);
  let score = ageDays;

  if (loop.dueDate) {
    const dueDays = (Date.parse(loop.dueDate) - now) / DAY_MS;
    if (dueDays < 0) {
      score += OVERDUE_BOOST + Math.min(-dueDays, OVERDUE_PER_DAY_CAP);
    } else if (dueDays <= DUE_SOON_WINDOW_DAYS) {
      score += DUE_SOON_BOOST * (1 - dueDays / DUE_SOON_WINDOW_DAYS);
    }
  }

  score += Math.max(0, loop.citationCount - 1) * REPEAT_MENTION_WEIGHT;
  return score;
}

/**
 * Score and sort a merged batch of loops: highest score first, ties broken by
 * age (oldest first) then id (stable). Returns fresh objects with `score` set.
 */
export function rankOpenLoops(loops: OpenLoopDto[], now: number): OpenLoopDto[] {
  return loops
    .map((loop) => ({ ...loop, score: scoreOpenLoop(loop, now) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ageDiff = Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt);
      if (ageDiff !== 0) return ageDiff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

import { z } from 'zod';
import { commitmentDirectionSchema } from './commitments';

/**
 * Contracts for the unified open-loop ledger (JJ-29) — the "Zeigarnik list": a
 * single ranked view of every UNRESOLVED thread across all recordings. It is a
 * READ-SIDE aggregation over the existing extraction sources — open tasks
 * (JJ-35), open commitments in both directions (JJ-36), and (once JJ-34 lands)
 * unanswered questions — normalized into one row shape so the UI renders them in
 * one list and the user can advance each with the same two actions.
 *
 * The ledger never owns state: an open loop's canonical row lives in its source
 * table (`tasks` / `commitments` / …). State mutations are DELEGATED back to
 * that source, so the user's `done`/`dropped` decision is exactly as durable
 * against re-extraction as it is on the source's own surface (task dedupe only
 * matches OPEN rows; commitment upsert preserves status and reaps only OPEN
 * stale rows). See `OpenLoopSource` in `@plaudern/open-loops`.
 */

/** Which extraction source an open loop was aggregated from. Extensible: `questions` (JJ-34) plugs in as a source without a contract change. */
export const openLoopKindSchema = z.enum(['task', 'commitment', 'question']);
export type OpenLoopKind = z.infer<typeof openLoopKindSchema>;

/**
 * Unified lifecycle across sources. Each source maps this onto its own enum:
 *  - task:       open ↔ open, done → completed, dropped → dismissed
 *  - commitment: open ↔ open, done → fulfilled, dropped → dismissed
 * `open` is the only state that appears in the default (unresolved) ledger.
 */
export const openLoopStateSchema = z.enum(['open', 'done', 'dropped']);
export type OpenLoopState = z.infer<typeof openLoopStateSchema>;

/** One normalized unresolved thread in the ledger. */
export const openLoopSchema = z.object({
  /** The source row id (a task id, a commitment id, …). Unique only WITHIN a kind. */
  id: z.string().uuid(),
  kind: openLoopKindSchema,
  state: openLoopStateSchema,
  /** Human-readable summary: the task title, the commitment description, the question. */
  title: z.string(),
  /**
   * For commitments, which way the obligation points (owed_by_me / owed_to_me);
   * null for kinds without a direction (tasks, questions).
   */
  direction: commitmentDirectionSchema.nullable(),
  /** The other party, when the source names one (commitments); else null. */
  counterpartyName: z.string().nullable(),
  /** Absolute due instant (ISO) when the source resolved one; else null. */
  dueDate: z.string().nullable(),
  /** Whether `dueDate` is in the past relative to the response time. */
  overdue: z.boolean(),
  /**
   * A recording to open for provenance: the commitment's item, or the most
   * recent recording that mentioned a task. Null when no single item applies.
   */
  inboxItemId: z.string().uuid().nullable(),
  /** Distinct recordings that raised this loop — a "keeps coming up" importance signal. */
  citationCount: z.number().int().nonnegative(),
  /** When the loop first opened (its age anchor for ranking). */
  firstSeenAt: z.string().datetime(),
  /** When the loop was most recently raised. */
  lastSeenAt: z.string().datetime(),
  /** Server ranking score (higher surfaces first); see `scoreOpenLoop`. */
  score: z.number(),
  /**
   * Reserved for evidence-based completion suggestions ("in yesterday's call you
   * said you sent it — mark done?"). v1 is read-only and no upstream extraction
   * emits completion evidence yet, so this is always null; the field is the
   * forward-compatible seam for that chip.
   */
  completionHint: z.string().nullable(),
});
export type OpenLoopDto = z.infer<typeof openLoopSchema>;

/**
 * Ledger query. Defaults surface only UNRESOLVED loops (the point of the view);
 * `includeResolved` brings done/dropped back for an "archive" toggle. `kind` and
 * `direction` narrow the list.
 */
export const openLoopListQuerySchema = z.object({
  kind: openLoopKindSchema.optional(),
  direction: commitmentDirectionSchema.optional(),
  /** Coerced from the `?includeResolved=true` query string. */
  includeResolved: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
});
export type OpenLoopListQuery = z.infer<typeof openLoopListQuerySchema>;

export const openLoopListResponseSchema = z.object({
  openLoops: z.array(openLoopSchema),
});
export type OpenLoopListResponse = z.infer<typeof openLoopListResponseSchema>;

/** Advance an open loop to `done`/`dropped` (or reopen it). */
export const updateOpenLoopStateRequestSchema = z.object({
  state: openLoopStateSchema,
});
export type UpdateOpenLoopStateRequest = z.infer<typeof updateOpenLoopStateRequestSchema>;

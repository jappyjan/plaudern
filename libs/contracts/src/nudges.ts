import { z } from 'zod';
import { commitmentDirectionSchema } from './commitments';

/**
 * Commitment-nudge contracts (JJ-26). A nudge is a PROACTIVE surface over the
 * extracted commitments (JJ-36) in BOTH directions:
 *  - owed_by_me: a promise you made whose deadline is approaching (or passed)
 *    with no later recording showing you followed through.
 *  - owed_to_me: an incoming promise that has gone stale, so you can chase it.
 *
 * Nudges are DERIVED (not stored): the eligible set is recomputed on every read
 * from the open commitments, their due/age, and a deterministic resolution
 * check against LATER recordings — only UNRESOLVED commitments are surfaced.
 * The only persisted piece is per-commitment nudge STATE (dismissed / snoozed /
 * already-notified), which the user owns and which survives re-extraction.
 */

/** Why a commitment is being nudged, driving the framing shown to the user. */
export const nudgeReasonSchema = z.enum(['due_soon', 'overdue', 'stale']);
export type NudgeReason = z.infer<typeof nudgeReasonSchema>;

/** One surfaced nudge over a single commitment. */
export const nudgeSchema = z.object({
  /** The underlying commitment row this nudge is derived from. */
  commitmentId: z.string().uuid(),
  /** The recording the commitment was made in, for provenance. */
  inboxItemId: z.string().uuid(),
  direction: commitmentDirectionSchema,
  /** The other party, when the commitment names one; else null. */
  counterpartyName: z.string().nullable(),
  /** What was promised (the commitment description). */
  description: z.string(),
  /** Absolute due instant (ISO) when the commitment resolved one; else null. */
  dueDate: z.string().nullable(),
  /** When the promise was made (the source recording's occurredAt, ISO). */
  occurredAt: z.string(),
  reason: nudgeReasonSchema,
  /**
   * A ready-to-send follow-up message the user can copy — the "want a nudge text
   * drafted?" affordance. Deterministically templated (no LLM call).
   */
  draftText: z.string(),
  /** User-set snooze instant (ISO); null when not snoozed. */
  snoozedUntil: z.string().nullable(),
  /** Whether a proactive notification has already fired for this nudge. */
  notified: z.boolean(),
});
export type NudgeDto = z.infer<typeof nudgeSchema>;

export const nudgeListResponseSchema = z.object({
  nudges: z.array(nudgeSchema),
  /**
   * Nudges are owner-relative (a commitment's direction is meaningless without
   * knowing who "me" is); without an owner the list is empty by construction, so
   * the UI prompts for one — mirroring the open-loops ledger.
   */
  needsOwner: z.boolean(),
});
export type NudgeListResponse = z.infer<typeof nudgeListResponseSchema>;

/**
 * A user action on a nudge. `dismiss` hides it permanently (the user does not
 * want to be reminded); `snooze` hides it for `snoozeDays` and re-arms the
 * proactive notification once the snooze elapses. Both are USER-owned state and
 * survive re-extraction of the underlying commitment.
 */
export const nudgeActionRequestSchema = z.object({
  action: z.enum(['dismiss', 'snooze']),
  /** Required for `snooze`; ignored for `dismiss`. */
  snoozeDays: z.number().int().min(1).max(90).optional(),
});
export type NudgeActionRequest = z.infer<typeof nudgeActionRequestSchema>;

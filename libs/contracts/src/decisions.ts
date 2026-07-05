import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `decisions` extraction kind (JJ-33): an LLM reads a
 * recording's transcript/summary and pulls out DECISIONS that were made —
 * "we decided to go with the cheaper option", "I'll switch banks", "we agreed
 * to postpone the trip". Each decision carries the statement itself, the
 * context/reasoning behind it, the participants involved (linked to the
 * per-user entity registry when a confident name match exists, else the raw
 * name is kept — mirroring the questions/commitments extractors), a citation
 * back to the source segment, and the model's confidence. Together they form a
 * searchable decision log: WHAT was decided, WHY, WHO was in the room, and
 * WHERE it was said.
 *
 * A `decisions` row is user-scoped and MUTABLE only in `status`: `active` is
 * extraction-owned (a re-run reaps active rows it no longer stands behind);
 * `revisited` and `superseded` are USER-owned states that a re-run never
 * overwrites and never reaps — the durability pattern copied from questions.
 * Deduped on (inboxItemId, normalizedDecision) so re-runs and backfills upsert
 * onto the same row instead of duplicating.
 */

/**
 * Lifecycle of a decision. `active` = the decision stands (extraction-owned —
 * a re-run reaps active rows it no longer re-produces); `revisited` = the user
 * flagged it for reconsideration; `superseded` = a later decision replaced it.
 * `revisited`/`superseded` are USER-owned: a re-run never demotes them back to
 * active and never reaps them, mirroring the questions `answered`/`dropped`
 * durability rule.
 */
export const decisionStatusSchema = z.enum(['active', 'revisited', 'superseded']);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

/**
 * One decision as produced by the LLM, before it is resolved + persisted.
 * `participants` is the people involved as spoken (empty when the model could
 * not name them). `context` is the short reasoning behind the decision.
 */
export const extractedDecisionSchema = z.object({
  /** The decision itself, in a short phrase ("go with the cheaper vendor"). */
  decision: z.string().min(1),
  /** The reasoning / context behind the decision, or null when none was given. */
  context: z.string().nullable().default(null),
  /**
   * The people involved in the decision as spoken ("Anna and me", "the team"),
   * or "" when unknown/unnamed.
   */
  participants: z.string().default(''),
  /** The model's confidence in the decision (0..1), or null when not provided. */
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** The transcript span the decision was drawn from, for provenance. */
  sourceQuote: z.string().nullable().default(null),
  /** Approximate segment start (seconds) the decision was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable().default(null),
});
export type ExtractedDecision = z.infer<typeof extractedDecisionSchema>;

/**
 * The persisted shape of a `decisions` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The resolved decisions live in
 * the `decisions` table; this is just the provenance the read model needs
 * without a join.
 */
export const decisionExtractionPayloadSchema = z.object({
  model: z.string(),
  /** How many decision rows this extraction produced for the item. */
  decisionCount: z.number().int().nonnegative(),
});
export type DecisionExtractionPayload = z.infer<typeof decisionExtractionPayloadSchema>;

/** A resolved, persisted decision as returned by the API. */
export const decisionSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  /** The decision statement. */
  decision: z.string(),
  /** The reasoning / context behind the decision; null when none was captured. */
  context: z.string().nullable(),
  /** The people involved as spoken; empty string when unknown. */
  participants: z.string(),
  /** Linked registry person entity id when a confident match exists, else null. */
  participantEntityId: z.string().uuid().nullable(),
  status: decisionStatusSchema,
  /** The model's confidence in the decision (0..1); null when not provided. */
  confidence: z.number().nullable(),
  /** Segment start (seconds into the recording) the decision was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable(),
  /** When the source recording occurred. */
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DecisionDto = z.infer<typeof decisionSchema>;

/**
 * Read model for an item's decisions tab. `status` tracks the async pipeline
 * step so the UI can show a spinner while extraction runs and render nothing
 * when the item has not been processed yet.
 */
export const itemDecisionsResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  decisions: z.array(decisionSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemDecisionsResponse = z.infer<typeof itemDecisionsResponseSchema>;

/**
 * Global decisions list query: optionally filter by status and/or participant
 * entity, so the searchable decision log can scope to one person or one state.
 */
export const decisionListQuerySchema = z.object({
  status: decisionStatusSchema.optional(),
  participantEntityId: z.string().uuid().optional(),
});
export type DecisionListQuery = z.infer<typeof decisionListQuerySchema>;

export const decisionListResponseSchema = z.object({
  decisions: z.array(decisionSchema),
});
export type DecisionListResponse = z.infer<typeof decisionListResponseSchema>;

/** Advance a decision's lifecycle status. */
export const updateDecisionStatusRequestSchema = z.object({
  status: decisionStatusSchema,
});
export type UpdateDecisionStatusRequest = z.infer<typeof updateDecisionStatusRequestSchema>;

import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `commitments` extraction kind (JJ-36): an LLM reads a
 * recording's speaker-attributed transcript and pulls out promissory language
 * in BOTH directions —
 *
 *   - "I'll send you the draft by Friday" → I owe the other party (owed_by_me).
 *   - "Tom said he'd check with the landlord" → the other party owes me
 *     (owed_to_me).
 *
 * Each commitment carries who/whom, what, an optional due date (relative
 * phrases resolved to an absolute instant against the item's `occurredAt` in
 * the extractor), a lifecycle status the user can advance, and the source
 * segment timestamp. Counterparties are linked to the per-user entity registry
 * (person entities) when a confident name match exists, else the raw name is
 * kept.
 */

/**
 * Which way a commitment points. `owed_by_me` = the owner promised the
 * counterparty something; `owed_to_me` = the counterparty promised the owner.
 */
export const commitmentDirectionSchema = z.enum(['owed_by_me', 'owed_to_me']);
export type CommitmentDirection = z.infer<typeof commitmentDirectionSchema>;

/** Lifecycle of a commitment; user-advanced from the item's commitments tab. */
export const commitmentStatusSchema = z.enum(['open', 'fulfilled', 'dismissed']);
export type CommitmentStatus = z.infer<typeof commitmentStatusSchema>;

/**
 * One commitment as produced by the LLM, before it is resolved + persisted.
 * `counterparty` is the other party's name as spoken (empty when the model
 * could not name them). `duePhrase` is the raw time expression ("Friday", "by
 * next week", "2026-07-10") which the extractor resolves against `occurredAt`.
 */
export const extractedCommitmentSchema = z.object({
  direction: commitmentDirectionSchema,
  /** The other party: to whom I owe it, or who owes me. May be empty/unknown. */
  counterparty: z.string().default(''),
  /** What was promised (the obligation), in a short phrase. */
  description: z.string().min(1),
  /** Raw promissory time expression, or null when none was stated. */
  duePhrase: z.string().nullable().default(null),
  /** The transcript span the commitment was drawn from, for provenance. */
  sourceQuote: z.string().nullable().default(null),
  /** Approximate segment start (seconds) the commitment was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable().default(null),
});
export type ExtractedCommitment = z.infer<typeof extractedCommitmentSchema>;

/**
 * The persisted shape of a `commitments` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The resolved commitments live in
 * the `commitments` table; this is just the provenance the read model needs
 * without a join.
 */
export const commitmentExtractionPayloadSchema = z.object({
  model: z.string(),
  /** How many commitment rows this extraction produced for the item. */
  commitmentCount: z.number().int().nonnegative(),
});
export type CommitmentExtractionPayload = z.infer<typeof commitmentExtractionPayloadSchema>;

/** A resolved, persisted commitment as returned by the API. */
export const commitmentSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  direction: commitmentDirectionSchema,
  /** The other party's display name; empty string when unknown. */
  counterpartyName: z.string(),
  /** Linked registry person entity id when a confident match exists, else null. */
  counterpartyEntityId: z.string().uuid().nullable(),
  /** What was promised. */
  description: z.string(),
  /** Absolute due instant resolved from the source phrase, or null. */
  dueDate: z.string().datetime().nullable(),
  status: commitmentStatusSchema,
  /** Segment start (seconds into the recording) the commitment was heard at. */
  sourceTimestamp: z.number().nonnegative().nullable(),
  /** When the source recording occurred (the resolution anchor). */
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CommitmentDto = z.infer<typeof commitmentSchema>;

/**
 * Read model for an item's commitments tab. `status` tracks the async pipeline
 * step so the UI can show a spinner while extraction runs and render nothing
 * when the item has not been processed yet.
 */
export const itemCommitmentsResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  commitments: z.array(commitmentSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  /**
   * True when the user has not designated an account owner ("This is me").
   * Direction (owed_by_me vs owed_to_me) is meaningless without it, so
   * commitments are neither extracted nor shown until an owner is set.
   */
  needsOwner: z.boolean().default(false),
});
export type ItemCommitmentsResponse = z.infer<typeof itemCommitmentsResponseSchema>;

/** Global commitments list query: optionally filter by direction and/or status. */
export const commitmentListQuerySchema = z.object({
  direction: commitmentDirectionSchema.optional(),
  status: commitmentStatusSchema.optional(),
});
export type CommitmentListQuery = z.infer<typeof commitmentListQuerySchema>;

export const commitmentListResponseSchema = z.object({
  commitments: z.array(commitmentSchema),
  /** True when no account owner is set — the list is empty until one is. */
  needsOwner: z.boolean().default(false),
});
export type CommitmentListResponse = z.infer<typeof commitmentListResponseSchema>;

/** Advance a commitment's lifecycle status. */
export const updateCommitmentStatusRequestSchema = z.object({
  status: commitmentStatusSchema,
});
export type UpdateCommitmentStatusRequest = z.infer<typeof updateCommitmentStatusRequestSchema>;

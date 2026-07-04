import { z } from 'zod';
import { extractionKindSchema } from './inbox';

/**
 * Contracts for the declarative extraction-pipeline DAG (VISION §8): graph
 * introspection plus backfill runs ("re-run kind@version over past items").
 */

/**
 * How an extractor depends on an upstream kind:
 * - `succeeded`: the dependency must apply to the item and have succeeded
 *   (e.g. a summary is impossible without a transcript).
 * - `settled`: if the dependency applies, wait until it reaches a terminal
 *   state, but tolerate failure (e.g. a summary still makes sense when
 *   diarization failed — it just loses speaker attribution).
 */
export const extractorDependencyRequirementSchema = z.enum(['succeeded', 'settled']);
export type ExtractorDependencyRequirement = z.infer<
  typeof extractorDependencyRequirementSchema
>;

export const extractorDependencySchema = z.object({
  kind: extractionKindSchema,
  requires: extractorDependencyRequirementSchema,
});
export type ExtractorDependencyDto = z.infer<typeof extractorDependencySchema>;

/** One node of the declarative extractor graph. */
export const extractorNodeSchema = z.object({
  kind: extractionKindSchema,
  /** Current version of this extractor; appended rows record it (kind@version). */
  version: z.number().int().positive(),
  /** False when the extractor's provider is not configured on this server. */
  enabled: z.boolean(),
  dependsOn: z.array(extractorDependencySchema),
});
export type ExtractorNodeDto = z.infer<typeof extractorNodeSchema>;

export const extractionGraphResponseSchema = z.object({
  extractors: z.array(extractorNodeSchema),
});
export type ExtractionGraphResponse = z.infer<typeof extractionGraphResponseSchema>;

/** Lifecycle of a backfill run. */
export const extractionRunStatusSchema = z.enum(['running', 'completed', 'failed']);
export type ExtractionRunStatus = z.infer<typeof extractionRunStatusSchema>;

/**
 * What triggered a backfill run:
 * - `manual`: an explicit POST /v1/extractions/backfills from a user.
 * - `startup`: the automatic sweep kicked off on every API boot, catching
 *   items whose step is missing or failed up to the current extractor version
 *   (so merging a new/improved processing step migrates old data on deploy).
 */
export const extractionRunTriggerSchema = z.enum(['manual', 'startup']);
export type ExtractionRunTrigger = z.infer<typeof extractionRunTriggerSchema>;

/**
 * Start a backfill: re-run one extraction kind (at its current version) over
 * the caller's past items. Non-forced runs skip items whose latest succeeded
 * row of that kind is already at (or above) the current version — the everyday
 * "the model improved, bump the version, catch the old items up" flow. `force`
 * re-runs regardless (fresh rows are appended either way; nothing is mutated).
 */
export const extractionBackfillRequestSchema = z.object({
  kind: extractionKindSchema,
  /** Only items that occurred at/after this instant. */
  occurredFrom: z.string().datetime().optional(),
  /** Only items that occurred at/before this instant. */
  occurredTo: z.string().datetime().optional(),
  force: z.boolean().default(false),
});
export type ExtractionBackfillRequest = z.infer<typeof extractionBackfillRequestSchema>;

export const extractionRunSchema = z.object({
  id: z.string().uuid(),
  kind: extractionKindSchema,
  /** Extractor version this run targets (the registered version at start time). */
  targetVersion: z.number().int().positive(),
  force: z.boolean(),
  /** How the run was triggered (manual request vs. automatic startup sweep). */
  trigger: extractionRunTriggerSchema,
  occurredFrom: z.string().datetime().nullable(),
  occurredTo: z.string().datetime().nullable(),
  status: extractionRunStatusSchema,
  /** Items examined so far. */
  itemsMatched: z.number().int().nonnegative(),
  /** Items for which a fresh extraction row was appended + queued. */
  itemsQueued: z.number().int().nonnegative(),
  /** Items skipped (not applicable, deps unmet, already at target version, or in flight). */
  itemsSkipped: z.number().int().nonnegative(),
  /** Items whose enqueue attempt itself failed. */
  itemsFailed: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type ExtractionRunDto = z.infer<typeof extractionRunSchema>;

export const extractionRunListResponseSchema = z.object({
  runs: z.array(extractionRunSchema),
});
export type ExtractionRunListResponse = z.infer<typeof extractionRunListResponseSchema>;

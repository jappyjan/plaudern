import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `facts` extraction kind (JJ-31): an LLM reads a recording's
 * transcript/summary and pulls out durable PERSONAL FACTS about the people in
 * the user's life — "my daughter starts school in August", "he's allergic to
 * nuts", "her birthday is in March", a gift idea someone mentioned. Each fact is
 * scoped to a person (linked to the per-user entity registry when the name
 * confidently matches a known `person` entity, else kept as a raw name) and
 * carries citations back to the recordings that stated it. These accumulate into
 * a per-person knowledge base that later powers the person dossier pages (JJ-24).
 *
 * Facts are APPEND-ONLY with SUPERSESSION: a newer fact about the same
 * (person, attribute) whose value differs marks the older one `superseded`
 * (pointing at the fact that replaced it) WITHOUT deleting it, so the history of
 * "school starts in August → moved to September" is preserved, not overwritten.
 * A `personal_facts` row lives outside the immutable inbox aggregate — it is a
 * derived, regenerable read model like a topic or a registry entity.
 */

/**
 * One candidate fact as produced by the LLM, before it is resolved + persisted.
 * `person` is the subject's name as spoken (empty when the model could not name
 * them). `attribute` is a short key naming WHAT the fact is about ("birthday",
 * "allergy", "schooling", "gift idea") — the axis a newer fact supersedes an
 * older one along. `value` is the fact itself.
 */
export const extractedFactSchema = z.object({
  /** The subject the fact is about: their name as spoken. May be empty/unknown. */
  person: z.string().default(''),
  /** Short key naming what the fact is about ("birthday", "allergy", "gift idea"). */
  attribute: z.string().min(1).max(80),
  /** The fact itself ("starts school in August", "allergic to nuts"). */
  value: z.string().min(1).max(500),
  /** The source sentence the fact was inferred from (for the citation). */
  quote: z.string().max(1000).nullish(),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

/**
 * The persisted shape of a `facts` extraction's `content` (stored as JSON on the
 * append-only extracted_payloads row). The resolved facts + their citations live
 * in the `personal_facts` / `personal_fact_citations` tables; this is just the
 * provenance the read model needs without a join.
 */
export const factExtractionPayloadSchema = z.object({
  model: z.string().nullable(),
  /** How many distinct facts this extraction cited (new or matched). */
  factCount: z.number().int().nonnegative(),
});
export type FactExtractionPayload = z.infer<typeof factExtractionPayloadSchema>;

/**
 * A resolved, persisted personal fact. Mutable only in the append-only sense:
 * citations accrete and `supersededByFactId` is set when a newer fact replaces
 * it; the row itself is never edited away or hard-deleted on supersession.
 */
export const personalFactSchema = z.object({
  id: z.string().uuid(),
  /** Linked registry `person` entity id when the name confidently matched, else null. */
  personEntityId: z.string().uuid().nullable(),
  /** The subject's display name as spoken; empty string when unknown. */
  personName: z.string(),
  /** Short key naming what the fact is about — the supersession axis. */
  attribute: z.string(),
  /** The fact itself. */
  value: z.string(),
  /** The fact that superseded this one (newer, same person+attribute), or null when active. */
  supersededByFactId: z.string().uuid().nullable(),
  /** When this fact was superseded (ISO), or null when still active. */
  supersededAt: z.string().datetime().nullable(),
  /** Convenience flag: true when nothing has superseded this fact. */
  active: z.boolean(),
  /** Distinct recordings that stated this fact (latest extraction per item only). */
  citationCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type PersonalFactDto = z.infer<typeof personalFactSchema>;

/**
 * A personal fact as cited by a specific recording — the unit an item's facts
 * tab renders. Carries THIS recording's quote/segment alongside the resolved
 * fact's fields, plus whether the fact has since been superseded.
 */
export const factCitationSchema = z.object({
  factId: z.string().uuid(),
  personEntityId: z.string().uuid().nullable(),
  personName: z.string(),
  attribute: z.string(),
  value: z.string(),
  /** Whether a newer fact has since superseded this one. */
  superseded: z.boolean(),
  /** The sentence this recording stated the fact in; null if not captured. */
  quote: z.string().nullable(),
  /** Segment start (seconds) into the recording, when the quote was located. */
  startSeconds: z.number().nullable(),
});
export type FactCitationDto = z.infer<typeof factCitationSchema>;

/**
 * Facts list query: optionally scope to a single person entity, and optionally
 * include superseded facts (the default hides them — active facts are the
 * current picture; superseded ones are history for the dossier timeline).
 */
export const factListQuerySchema = z.object({
  personEntityId: z.string().uuid().optional(),
  // Query params arrive as strings, so coerce explicitly: only "true"/"1"
  // enable it. `z.coerce.boolean()` is WRONG here — it maps any non-empty
  // string (including "false") to true.
  includeSuperseded: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => v === true || v === 'true' || v === '1'),
});
export type FactListQuery = z.infer<typeof factListQuerySchema>;

export const factListResponseSchema = z.object({
  facts: z.array(personalFactSchema),
});
export type FactListResponse = z.infer<typeof factListResponseSchema>;

/**
 * Read model for an item's facts tab. `status` tracks the async pipeline step so
 * the UI can show a spinner while extraction runs and render nothing when the
 * item has not been processed yet.
 */
export const itemFactsResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  facts: z.array(factCitationSchema),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemFactsResponse = z.infer<typeof itemFactsResponseSchema>;

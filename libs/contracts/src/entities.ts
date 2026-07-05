import { z } from 'zod';

/**
 * Contracts for the `entities` extraction kind (JJ-32): an LLM reads a
 * recording's transcript and pulls out named entities, which are normalized
 * into a per-user **entity registry** — the seed of the knowledge graph.
 *
 * `person` entities are linked to the existing voice-profile contact book
 * (speaker-id) whenever their name matches a known profile, so a person looks
 * and links the same whether they were heard or merely mentioned.
 */

/** The kinds of entity the extractor recognizes (VISION §8 / JJ-32). */
export const entityTypeSchema = z.enum([
  'person',
  'organization',
  'place',
  'date',
  'amount',
  'product',
  'medication',
  'document_reference',
]);
export type EntityType = z.infer<typeof entityTypeSchema>;

/**
 * One entity as produced by the LLM before it is normalized into the registry.
 * `name` is the canonical form the model settled on; `mentions` are the exact
 * surface forms it saw in the transcript (kept as aliases on the registry row).
 */
export const extractedEntitySchema = z.object({
  type: entityTypeSchema,
  /** Canonical name/label, e.g. "Angela Merkel", "Ibuprofen 400mg". */
  name: z.string().min(1),
  /** Surface forms as they appeared in the text (aliases); may be empty. */
  mentions: z.array(z.string().min(1)).default([]),
});
export type ExtractedEntity = z.infer<typeof extractedEntitySchema>;

/**
 * The persisted shape of an `entities` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The normalized entities and
 * their mentions live in the `entities` / `entity_mentions` tables; this is
 * just the provenance/summary the read model needs without a join.
 */
export const entityExtractionPayloadSchema = z.object({
  model: z.string(),
  /** How many distinct registry entities this extraction linked to the item. */
  entityCount: z.number().int().nonnegative(),
});
export type EntityExtractionPayload = z.infer<typeof entityExtractionPayloadSchema>;

/**
 * Provenance of a person entity's contact link. `auto` = matched by name/
 * recording context, `manual` = the user linked (or converted) it themselves,
 * `suppressed` = the user unlinked it and auto-linking must not re-link.
 * `suppressed` only ever appears together with a null `voiceProfileId`.
 */
export const contactLinkOriginSchema = z.enum(['auto', 'manual', 'suppressed']);
export type ContactLinkOrigin = z.infer<typeof contactLinkOriginSchema>;

/**
 * A normalized entity in the per-user registry. Mutable (aliases accrete,
 * person links resolve), so it lives outside the immutable inbox aggregate —
 * exactly like a voice profile.
 */
export const registryEntitySchema = z.object({
  id: z.string().uuid(),
  type: entityTypeSchema,
  /** Display/canonical name. */
  canonicalName: z.string(),
  /** Known surface forms/spellings collapsed into this entity. */
  aliases: z.array(z.string()),
  /**
   * Linked voice-profile id when this `person` entity matches a contact in the
   * speaker-id contact book; null otherwise (and always null for non-people).
   */
  voiceProfileId: z.string().uuid().nullable(),
  /** How the contact link came to be (or why auto-linking is off). */
  voiceProfileLinkOrigin: contactLinkOriginSchema.nullable(),
  /** Linked contact's display name, for rendering without a second fetch. */
  voiceProfileName: z.string().nullable(),
  /** Distinct recordings this entity is mentioned in (latest extraction only). */
  mentionCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type RegistryEntityDto = z.infer<typeof registryEntitySchema>;

/** One appearance of a registry entity in a specific recording. */
export const entityMentionSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  /** The surface form as it appeared in that recording. */
  surfaceForm: z.string(),
  createdAt: z.string().datetime(),
});
export type EntityMentionDto = z.infer<typeof entityMentionSchema>;

/** Registry list query: optionally filter to a single entity type. */
export const entityListQuerySchema = z.object({
  type: entityTypeSchema.optional(),
  /**
   * Also return registry rows no current extraction mentions any more (ghosts
   * left behind by reprocessing or deletes). Hidden by default so the list
   * reflects what the recordings actually say today.
   */
  includeUnreferenced: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type EntityListQuery = z.infer<typeof entityListQuerySchema>;

export const entityListResponseSchema = z.object({
  entities: z.array(registryEntitySchema),
});
export type EntityListResponse = z.infer<typeof entityListResponseSchema>;

/** A registry entity together with its mentions (newest first). */
export const entityDetailSchema = registryEntitySchema.extend({
  mentions: z.array(entityMentionSchema),
});
export type EntityDetailDto = z.infer<typeof entityDetailSchema>;

/**
 * Merge & correction tooling (JJ-63). The entity detail read model (with
 * relations, `entityDetailWithRelationsSchema` in ./relations) is the response
 * for every mutation below, so the UI can refresh from one call.
 */

/**
 * POST /v1/entities/:id/merge — union the victim into the survivor addressed by
 * the URL, then delete the victim. The victim's names are recorded as aliases
 * of the survivor so future extraction resolves to it instead of resurrecting a
 * duplicate. The two entities may be of DIFFERENT types (e.g. an organization
 * and a product the extractor split apart); the survivor's type is kept, and
 * the victim's names are aliased under both types so a later extraction under
 * either type folds onto the survivor.
 */
export const mergeEntityRequestSchema = z.object({
  /** The entity merged INTO the survivor (:id), then deleted. */
  victimId: z.string().uuid(),
});
export type MergeEntityRequest = z.infer<typeof mergeEntityRequestSchema>;

/**
 * Duplicate detection (JJ-63). Why a candidate is a likely duplicate of the
 * subject entity: `exact-cross-type` = identical (folded) name under a
 * DIFFERENT type — the split-typed case; `fuzzy` = a similar name (possibly the
 * same type), lexically close enough to be worth confirming.
 */
export const duplicateReasonSchema = z.enum(['exact-cross-type', 'fuzzy']);
export type DuplicateReason = z.infer<typeof duplicateReasonSchema>;

export const duplicateCandidateSchema = z.object({
  candidate: registryEntitySchema,
  reason: duplicateReasonSchema,
  /** Match strength in [0,1]: 1 for exact, name affinity for fuzzy. */
  score: z.number().min(0).max(1),
});
export type DuplicateCandidateDto = z.infer<typeof duplicateCandidateSchema>;

/** GET /v1/entities/:id/duplicate-candidates — include fuzzy/similar names too. */
export const duplicateCandidatesQuerySchema = z.object({
  fuzzy: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});
export type DuplicateCandidatesQuery = z.infer<typeof duplicateCandidatesQuerySchema>;

export const duplicateCandidatesResponseSchema = z.object({
  candidates: z.array(duplicateCandidateSchema),
});
export type DuplicateCandidatesResponse = z.infer<typeof duplicateCandidatesResponseSchema>;

/**
 * PATCH /v1/entities/:id — correct a registry entity: rename it and/or change
 * its type. Renaming keeps the OLD normalized name as a durable alias (and, on
 * retype, the old (type, name) too) so re-extraction folds back in instead of
 * recreating; re-typing away from `person` drops any contact link.
 */
export const updateEntityRequestSchema = z
  .object({
    canonicalName: z.string().trim().min(1).max(200).optional(),
    type: entityTypeSchema.optional(),
  })
  .refine((req) => req.canonicalName !== undefined || req.type !== undefined, {
    message: 'nothing to update',
  });
export type UpdateEntityRequest = z.infer<typeof updateEntityRequestSchema>;

/** Manually link a `person` entity to a contact-book voice profile. */
export const linkEntityContactRequestSchema = z.object({
  voiceProfileId: z.string().uuid(),
});
export type LinkEntityContactRequest = z.infer<typeof linkEntityContactRequestSchema>;

/** Result of an auto-link sweep over all unlinked person entities. */
export const autoLinkEntitiesResponseSchema = z.object({
  /** How many person entities gained a contact link in this sweep. */
  linked: z.number().int().nonnegative(),
});
export type AutoLinkEntitiesResponse = z.infer<typeof autoLinkEntitiesResponseSchema>;

/**
 * One ranked contact candidate for a person entity, produced by the identity
 * resolver from real evidence (name affinity, whose voice is in the recordings
 * mentioning the person, shared knowledge-graph connections). `reasons` are
 * human-readable so the UI can show *why* a contact is suggested.
 */
export const entityContactSuggestionSchema = z.object({
  voiceProfileId: z.string().uuid(),
  name: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
});
export type EntityContactSuggestionDto = z.infer<typeof entityContactSuggestionSchema>;

/** GET /v1/entities/:id/contact-suggestions — best candidates first. */
export const entityContactSuggestionsResponseSchema = z.object({
  suggestions: z.array(entityContactSuggestionSchema),
});
export type EntityContactSuggestionsResponse = z.infer<
  typeof entityContactSuggestionsResponseSchema
>;

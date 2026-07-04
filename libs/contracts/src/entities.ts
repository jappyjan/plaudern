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

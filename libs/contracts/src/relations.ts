import { z } from 'zod';
import { entityDetailSchema, entityTypeSchema } from './entities';

/**
 * Contracts for the `relations` extraction kind and the knowledge graph
 * (JJ-22): typed edges between registry entities, LLM-extracted from a
 * recording's transcript (plus weak implicit co-occurrence edges), and the
 * graph queries vector search can't answer — "everything connecting the
 * landlord, the contract, and the water damage".
 */

/** The constrained relation vocabulary the extractor may use (JJ-22). */
export const relationTypeSchema = z.enum([
  'works_at',
  'located_in',
  'involved_in',
  'discussed_with',
  'promised_to',
  'related_to',
  'part_of',
  'owns',
]);
export type RelationType = z.infer<typeof relationTypeSchema>;

/**
 * How an edge came to be: explicitly stated by the LLM, or implied by two
 * entities co-occurring in the same recording (always a weak `related_to`).
 */
export const relationOriginSchema = z.enum(['llm', 'cooccurrence']);
export type RelationOrigin = z.infer<typeof relationOriginSchema>;

/**
 * One relation as produced by the LLM, before validation. `source` and
 * `target` name entities from the SAME item's `entities` extraction; anything
 * that does not resolve to one of them is dropped, never written.
 */
export const extractedRelationSchema = z.object({
  type: relationTypeSchema,
  /** Name of the source entity, as listed in this item's extracted entities. */
  source: z.string().min(1),
  /** Name of the target entity, as listed in this item's extracted entities. */
  target: z.string().min(1),
  /** Short free-text qualifier in the transcript's own words. */
  label: z.string().optional(),
  /** Model-reported confidence in [0, 1]. */
  confidence: z.number().min(0).max(1).optional(),
});
export type ExtractedRelation = z.infer<typeof extractedRelationSchema>;

/**
 * The persisted shape of a `relations` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The edges themselves live in the
 * `entity_relations` table; this is just the provenance/summary.
 */
export const relationExtractionPayloadSchema = z.object({
  model: z.string(),
  /** Evidence rows this extraction wrote (explicit + co-occurrence). */
  relationCount: z.number().int().nonnegative(),
});
export type RelationExtractionPayload = z.infer<typeof relationExtractionPayloadSchema>;

/** A light graph node — enough to render an edge endpoint without a join. */
export const graphEntitySchema = z.object({
  id: z.string().uuid(),
  type: entityTypeSchema,
  canonicalName: z.string(),
});
export type GraphEntityDto = z.infer<typeof graphEntitySchema>;

/**
 * One aggregated edge of the knowledge graph: all evidence rows for
 * (source, target, relationType) collapsed across recordings. Evidence is
 * restricted to each item's latest succeeded `relations` extraction, exactly
 * like entity mentions.
 */
export const entityRelationEdgeSchema = z.object({
  sourceEntityId: z.string().uuid(),
  targetEntityId: z.string().uuid(),
  relationType: relationTypeSchema,
  /** Latest non-empty qualifier any evidence carried; null when none did. */
  label: z.string().nullable(),
  /** Highest confidence any evidence carried; null when none reported one. */
  confidence: z.number().min(0).max(1).nullable(),
  /** `llm` as soon as any evidence was explicit; `cooccurrence` otherwise. */
  origin: relationOriginSchema,
  /** Distinct recordings evidencing this edge (latest extraction only). */
  evidenceCount: z.number().int().nonnegative(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type EntityRelationEdgeDto = z.infer<typeof entityRelationEdgeSchema>;

/** GET /v1/entities/:id — the detail read model extended with its edges. */
export const entityDetailWithRelationsSchema = entityDetailSchema.extend({
  relations: z.array(entityRelationEdgeSchema),
});
export type EntityDetailWithRelationsDto = z.infer<typeof entityDetailWithRelationsSchema>;

/** Neighborhood query: optionally restrict to one relation type. */
export const entityNeighborhoodQuerySchema = z.object({
  relationType: relationTypeSchema.optional(),
});
export type EntityNeighborhoodQuery = z.infer<typeof entityNeighborhoodQuerySchema>;

/** GET /v1/entities/:id/neighborhood — one hop of edges + connected entities. */
export const entityNeighborhoodResponseSchema = z.object({
  entity: graphEntitySchema,
  relations: z.array(entityRelationEdgeSchema),
  neighbors: z.array(graphEntitySchema),
});
export type EntityNeighborhoodResponse = z.infer<typeof entityNeighborhoodResponseSchema>;

/** Hard ceiling on graph traversal depth (hops). */
export const MAX_GRAPH_DEPTH = 3;

/**
 * GET /v1/entities/graph/connect — the subgraph connecting 2–3 entities:
 * shortest paths (≤ maxDepth hops) from the first id to each of the others.
 */
export const entityConnectQuerySchema = z.object({
  /** Comma-separated list of 2–3 entity ids. */
  ids: z
    .string()
    .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
    .pipe(z.array(z.string().uuid()).min(2).max(3)),
  maxDepth: z.coerce.number().int().min(1).max(MAX_GRAPH_DEPTH).default(MAX_GRAPH_DEPTH),
});
export type EntityConnectQuery = z.infer<typeof entityConnectQuerySchema>;

export const entityConnectResponseSchema = z.object({
  entities: z.array(graphEntitySchema),
  relations: z.array(entityRelationEdgeSchema),
  /** True iff every requested entity was reachable from the first one. */
  connected: z.boolean(),
});
export type EntityConnectResponse = z.infer<typeof entityConnectResponseSchema>;

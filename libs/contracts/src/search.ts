import { z } from 'zod';
import { sourceTypeSchema } from './source-type';
import { embeddingChunkSourceSchema } from './embedding';

/**
 * Hybrid search over the whole memory (JJ-38): a semantic leg (pgvector),
 * a keyword leg (Postgres full-text search) and structured filters, fused
 * with Reciprocal Rank Fusion. The semantic leg degrades gracefully — when the
 * embeddings provider is unconfigured the response still returns keyword +
 * filter results and records that the semantic leg did not run.
 */

/** Whether a retrieval leg contributed to a response. */
export const searchLegStatusSchema = z.enum(['ran', 'skipped', 'unavailable']);
export type SearchLegStatus = z.infer<typeof searchLegStatusSchema>;

/**
 * Structured filters that constrain BOTH legs (a pre-filter over the candidate
 * items). All optional; every dimension present is AND-combined. `from`/`to`
 * bound `occurredAt` (inclusive), which is stored as an ISO-8601 UTC string so
 * lexicographic comparison is chronological.
 */
export const searchFiltersSchema = z.object({
  /** Restrict to one source/kind (audio, text, plaud, …). */
  sourceType: sourceTypeSchema.optional(),
  /** Restrict to items assigned this topic (latest classification). */
  topicId: z.string().uuid().optional(),
  /** Restrict to items mentioning this registry entity (person/place/org/…). */
  entityId: z.string().uuid().optional(),
  /** occurredAt >= from (ISO-8601). */
  from: z.string().datetime({ offset: true }).optional(),
  /** occurredAt <= to (ISO-8601). */
  to: z.string().datetime({ offset: true }).optional(),
});
export type SearchFilters = z.infer<typeof searchFiltersSchema>;

export function hasAnySearchFilter(filters: SearchFilters | undefined): boolean {
  if (!filters) return false;
  return Boolean(
    filters.sourceType || filters.topicId || filters.entityId || filters.from || filters.to,
  );
}

/**
 * A search request. `query` OR at least one filter must be present: a bare
 * filter set is a valid "browse by filter" query (newest-first), and a bare
 * text query runs the full hybrid pipeline.
 */
export const searchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(500).optional(),
    filters: searchFiltersSchema.optional(),
    limit: z.number().int().positive().max(50).optional(),
  })
  .refine((v) => Boolean(v.query) || hasAnySearchFilter(v.filters), {
    message: 'provide a query or at least one filter',
  });
export type SearchRequest = z.infer<typeof searchRequestSchema>;

/** One fused search hit for a distinct inbox item. */
export const searchResultItemSchema = z.object({
  itemId: z.string(),
  /** Best-effort display title (metadata tag title or summary title). */
  title: z.string().nullable(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string(),
  /** Matched passage. May contain `<mark>` highlight markers (keyword leg). */
  snippet: z.string().nullable(),
  /** Which derived artifact the snippet came from. */
  snippetSource: embeddingChunkSourceSchema.nullable(),
  /** Segment window (seconds) for a transcript hit; null otherwise. */
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  /** Cosine similarity from the semantic leg (null when it did not match). */
  semanticScore: z.number().nullable(),
  /** 1-indexed rank within the semantic leg (null when it did not match). */
  semanticRank: z.number().int().nullable(),
  /** ts_rank score from the keyword leg (null when it did not match). */
  keywordScore: z.number().nullable(),
  /** 1-indexed rank within the keyword leg (null when it did not match). */
  keywordRank: z.number().int().nullable(),
  /** Reciprocal-Rank-Fusion score across the legs that ran. */
  fusedScore: z.number(),
  /** 1-indexed final rank in the fused result list. */
  rank: z.number().int(),
});
export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

/** Which legs ran, plus human-readable notes (e.g. why a leg was skipped). */
export const searchLegsSchema = z.object({
  semantic: searchLegStatusSchema,
  keyword: searchLegStatusSchema,
  notes: z.array(z.string()),
});
export type SearchLegs = z.infer<typeof searchLegsSchema>;

export const searchResponseSchema = z.object({
  results: z.array(searchResultItemSchema),
  legs: searchLegsSchema,
});
export type SearchResponse = z.infer<typeof searchResponseSchema>;

/** One "more like this" hit (vector leg only). */
export const similarItemSchema = z.object({
  itemId: z.string(),
  title: z.string().nullable(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string(),
  snippet: z.string().nullable(),
  snippetSource: embeddingChunkSourceSchema.nullable(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  /** Cosine similarity to the source item's embedding centroid. */
  score: z.number(),
});
export type SimilarItem = z.infer<typeof similarItemSchema>;

/**
 * "More like this" response. `available` is false only when semantic search
 * cannot run at all (embeddings provider unconfigured); `reason` explains an
 * empty result (no embeddings for the item yet, or no similar items found).
 */
export const similarResponseSchema = z.object({
  results: z.array(similarItemSchema),
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type SimilarResponse = z.infer<typeof similarResponseSchema>;

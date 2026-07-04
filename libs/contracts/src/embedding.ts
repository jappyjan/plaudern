import { z } from 'zod';

/**
 * Which derived artifact a chunk's text came from. `transcript` chunks carry
 * segment timestamps (so a retrieval hit can deep-link into the audio);
 * `summary` chunks are timeless prose.
 */
export const embeddingChunkSourceSchema = z.enum(['transcript', 'summary']);
export type EmbeddingChunkSource = z.infer<typeof embeddingChunkSourceSchema>;

/**
 * The persisted shape of an `embedding` extraction's `content` (stored as JSON
 * on the append-only extracted_payloads row). The vectors themselves live in
 * the `embedding_chunks` table (pgvector); this is just the provenance/summary
 * the read model and UI need without loading every vector.
 */
export const embeddingPayloadSchema = z.object({
  model: z.string(),
  dimensions: z.number().int().positive(),
  chunkCount: z.number().int().nonnegative(),
  /** How many chunks came from each source, for quick diagnostics. */
  transcriptChunks: z.number().int().nonnegative(),
  summaryChunks: z.number().int().nonnegative(),
});
export type EmbeddingPayload = z.infer<typeof embeddingPayloadSchema>;

/**
 * A single stored chunk with its vector — the retrieval unit. `startSeconds` /
 * `endSeconds` are present for transcript chunks and null for summary chunks.
 */
export const embeddingChunkSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  source: embeddingChunkSourceSchema,
  chunkIndex: z.number().int().nonnegative(),
  text: z.string(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
  model: z.string(),
  dimensions: z.number().int().positive(),
});
export type EmbeddingChunkDto = z.infer<typeof embeddingChunkSchema>;

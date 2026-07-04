/**
 * Default embedding dimension — `text-embedding-3-small`, the default provider
 * model. Must match the `vector(N)` column dimension in the pgvector migration
 * (`…015-CreateEmbeddingChunks`); changing it needs a follow-up migration.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingResult {
  /** One vector per input text, in the same order. */
  vectors: number[][];
  /** Concrete model that produced the vectors, for provenance. */
  model: string;
  /** Dimension of every returned vector. */
  dimensions: number;
}

/**
 * Embedding backend. The default is an OpenAI-compatible `/embeddings` provider
 * (works with OpenAI, a local text-embeddings-inference gateway, etc.). Tests
 * override the DI token with a deterministic fake.
 */
export interface EmbeddingProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  /** Dimension the provider emits — used to validate/allocate the vector column. */
  readonly dimensions: number;
  /** Embed a batch of texts; returns one vector per input, order preserved. */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { EmbeddingChunkSource } from '@plaudern/contracts';
import { EmbeddingChunkEntity } from '@plaudern/persistence';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';

/** One item's mean embedding, the unit clustered by the taxonomy proposer (JJ-64). */
export interface ItemCentroid {
  inboxItemId: string;
  /** Mean of the item's chunk vectors (unnormalized); dimension is uniform. */
  vector: number[];
}

/** One retrieval hit: the best-matching chunk of a distinct inbox item. */
export interface EmbeddingSearchHit {
  inboxItemId: string;
  chunkId: string;
  source: EmbeddingChunkSource;
  /** The chunk text — the snippet a caller shows or feeds to an LLM. */
  text: string;
  /** Segment start/end (seconds) for transcript chunks; null for summary chunks. */
  startSeconds: number | null;
  endSeconds: number | null;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

/**
 * Semantic search over the per-user embedding chunks (the retrieval half of the
 * pipeline whose write half is `EmbeddingProcessor`). Embeds the query with the
 * same provider that produced the stored vectors, then finds the nearest chunks
 * by cosine distance — natively via pgvector's `<=>` on Postgres, or with an
 * in-JS cosine on the sqlite test database (which has no pgvector).
 *
 * Results are collapsed to one hit per inbox item (the item's best-scoring
 * chunk), so a caller gets N distinct memories rather than N chunks of the same
 * recording. Every query is scoped to `userId`, so one user can never retrieve
 * another's memory.
 */
@Injectable()
export class EmbeddingSearchService {
  constructor(
    @Inject(EMBEDDING_PROVIDER)
    private readonly provider: EmbeddingProvider,
    @InjectRepository(EmbeddingChunkEntity)
    private readonly chunks: Repository<EmbeddingChunkEntity>,
  ) {}

  /** Whether semantic search can run (the embedding provider is configured). */
  isEnabled(userId: string): Promise<boolean> {
    return this.provider.isEnabled(userId);
  }

  async search(userId: string, queryText: string, limit: number): Promise<EmbeddingSearchHit[]> {
    if (!(await this.provider.isEnabled(userId))) {
      throw new BadRequestException(
        'semantic search is unavailable because embeddings are not configured — assign a provider to the embeddings capability in Settings → AI',
      );
    }
    const trimmed = queryText.trim();
    if (!trimmed) throw new BadRequestException('search query must not be empty');

    const { vectors } = await this.provider.embed(userId, [trimmed]);
    const queryVector = vectors[0];
    if (!queryVector?.length) return [];

    const driver = this.chunks.manager.connection.options.type;
    return driver === 'postgres'
      ? this.searchPostgres(userId, queryVector, limit)
      : this.searchInMemory(userId, queryVector, limit);
  }

  /**
   * Mean embedding per item over the given item ids (JJ-64 clustering input).
   * Averages each item's chunk vectors in JS — driver-agnostic (works on the
   * sqlite test DB, which has no pgvector `avg()`), and cheap at the recent-item
   * scale the proposer operates on. Chunks whose dimension doesn't match the
   * item's first chunk are skipped (a provider/model change mid-history), and
   * items with no usable chunks are omitted, so callers get only items that can
   * actually be clustered.
   */
  async itemCentroids(userId: string, inboxItemIds: string[]): Promise<ItemCentroid[]> {
    if (inboxItemIds.length === 0) return [];
    const rows = await this.chunks.find({
      where: { userId, inboxItemId: In(inboxItemIds) },
    });
    const sums = new Map<string, { sum: number[]; count: number; dims: number }>();
    for (const row of rows) {
      const vector = row.embedding;
      if (!vector?.length) continue;
      const existing = sums.get(row.inboxItemId);
      if (!existing) {
        sums.set(row.inboxItemId, { sum: [...vector], count: 1, dims: vector.length });
        continue;
      }
      // Guard against mixed-dimension history: only average matching vectors.
      if (vector.length !== existing.dims) continue;
      for (let i = 0; i < existing.dims; i++) existing.sum[i] += vector[i];
      existing.count += 1;
    }
    const centroids: ItemCentroid[] = [];
    for (const [inboxItemId, { sum, count }] of sums) {
      centroids.push({ inboxItemId, vector: sum.map((v) => v / count) });
    }
    return centroids;
  }

  /**
   * Native pgvector nearest-neighbour: one best chunk per item via DISTINCT ON,
   * then ordered by distance across items. Uses cosine distance (`<=>`), which
   * the HNSW index (`vector_cosine_ops`) accelerates.
   *
   * No dimension guard is needed here (unlike the in-memory path): the column
   * is a fixed-dimension `vector(N)` (frozen by the `…019-CreateEmbeddingChunks`
   * migration), so every stored row has exactly N dims — Postgres rejects any
   * other insert. The query vector matches too, because it comes from the same
   * provider that produced the stored rows.
   */
  private async searchPostgres(
    userId: string,
    queryVector: number[],
    limit: number,
  ): Promise<EmbeddingSearchHit[]> {
    const literal = `[${queryVector.join(',')}]`;
    const rows: Array<{
      id: string;
      inboxItemId: string;
      source: EmbeddingChunkSource;
      text: string;
      startSeconds: number | null;
      endSeconds: number | null;
      distance: number | string;
    }> = await this.chunks.query(
      `SELECT id, "inboxItemId", source, text, "startSeconds", "endSeconds", distance
       FROM (
         SELECT DISTINCT ON ("inboxItemId")
           id, "inboxItemId", source, text, "startSeconds", "endSeconds",
           (embedding <=> $1::vector) AS distance
         FROM embedding_chunks
         WHERE "userId" = $2
         ORDER BY "inboxItemId", distance ASC
       ) best
       ORDER BY distance ASC
       LIMIT $3`,
      [literal, userId, limit],
    );
    return rows.map((row) => ({
      inboxItemId: row.inboxItemId,
      chunkId: row.id,
      source: row.source,
      text: row.text,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds,
      score: 1 - Number(row.distance),
    }));
  }

  /**
   * Portable fallback for the sqlite test database (no pgvector): load the
   * user's chunks and rank them with an in-JS cosine. Fine at test scale;
   * production runs the native pgvector path above.
   */
  private async searchInMemory(
    userId: string,
    queryVector: number[],
    limit: number,
  ): Promise<EmbeddingSearchHit[]> {
    const rows = await this.chunks.find({ where: { userId } });
    const bestPerItem = new Map<string, EmbeddingSearchHit>();
    for (const row of rows) {
      if (row.embedding.length !== queryVector.length) continue;
      const score = cosineSimilarity(queryVector, row.embedding);
      const existing = bestPerItem.get(row.inboxItemId);
      if (!existing || score > existing.score) {
        bestPerItem.set(row.inboxItemId, {
          inboxItemId: row.inboxItemId,
          chunkId: row.id,
          source: row.source,
          text: row.text,
          startSeconds: row.startSeconds,
          endSeconds: row.endSeconds,
          score,
        });
      }
    }
    return [...bestPerItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

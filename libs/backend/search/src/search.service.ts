import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
  hasAnySearchFilter,
  summaryPayloadSchema,
  type EmbeddingChunkSource,
  type SearchFilters,
  type SearchLegStatus,
  type SearchRequest,
  type SearchResponse,
  type SearchResultItem,
  type SensitivityTier,
  type SimilarItem,
  type SimilarResponse,
  type SourceType,
} from '@plaudern/contracts';
import {
  EmbeddingChunkEntity,
  EntityMentionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemSensitivityEntity,
  ItemTopicEntity,
} from '@plaudern/persistence';
import { EmbeddingSearchService, type EmbeddingSearchHit } from '@plaudern/embeddings';
import { KeywordSearchService, type KeywordHit } from './keyword-search.service';
import { fuseRankings, type LegRanking } from './rrf';

const DEFAULT_LIMIT = 20;

/** Minimal display metadata for a result item. */
interface ItemMeta {
  itemId: string;
  title: string | null;
  sourceType: SourceType;
  occurredAt: string;
  /** Effective sensitivity tier (JJ-21); null when unclassified. */
  sensitivityTier: SensitivityTier | null;
}

/**
 * Hybrid search (JJ-38): fuses the keyword (FTS) and semantic (pgvector) legs
 * with Reciprocal Rank Fusion, constrained by structured filters that apply to
 * BOTH legs, and powers "more like this" (vector leg only). Every method is
 * user-scoped, so one user can never retrieve another's memory.
 *
 * Graceful degradation is a first-class result, not an error: when the query is
 * empty it becomes a filter-only browse; when the embeddings provider is
 * unconfigured the semantic leg is marked `unavailable` and the response still
 * carries keyword + filter results. The `legs` block records exactly what ran.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly embeddingSearch: EmbeddingSearchService,
    private readonly keyword: KeywordSearchService,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(EntityMentionEntity)
    private readonly mentions: Repository<EntityMentionEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly itemTopics: Repository<ItemTopicEntity>,
    @InjectRepository(EmbeddingChunkEntity)
    private readonly chunks: Repository<EmbeddingChunkEntity>,
    @InjectRepository(ItemSensitivityEntity)
    private readonly sensitivity: Repository<ItemSensitivityEntity>,
  ) {}

  async search(userId: string, req: SearchRequest): Promise<SearchResponse> {
    const limit = req.limit ?? DEFAULT_LIMIT;
    const query = req.query?.trim();
    const filters = req.filters;
    const hasFilters = hasAnySearchFilter(filters);
    const notes: string[] = [];

    // Resolve the filter-allowed item set once; both legs pre-filter with it.
    const allowed = hasFilters ? await this.resolveAllowedItems(userId, filters!) : null;
    if (allowed && allowed.size === 0) {
      return {
        results: [],
        legs: {
          semantic: query
            ? statusForSemantic(await this.embeddingSearch.isEnabled(userId))
            : 'skipped',
          keyword: query ? 'ran' : 'skipped',
          notes: ['no items match the given filters'],
        },
      };
    }

    // Filter-only browse: no query text to rank on, so return newest-first.
    if (!query) {
      const results = await this.browseByFilter(userId, allowed, limit);
      return {
        results,
        legs: {
          semantic: 'skipped',
          keyword: 'skipped',
          notes: ['browse by filter (no query text): results ordered newest first'],
        },
      };
    }

    const pool = Math.max(limit * 4, 40);

    // --- keyword leg (always runs when there is a query) ---
    const keywordHits = await this.keyword.search(userId, query, pool, allowed);
    const keywordStatus: SearchLegStatus = 'ran';

    // --- semantic leg (degrades gracefully) ---
    let semanticHits: EmbeddingSearchHit[] = [];
    let semanticStatus: SearchLegStatus;
    if (!(await this.embeddingSearch.isEnabled(userId))) {
      semanticStatus = 'unavailable';
      notes.push(
        'semantic search unavailable: embeddings provider not configured — returning keyword + filter results only',
      );
    } else {
      const raw = await this.embeddingSearch.search(userId, query, pool);
      semanticHits = allowed ? raw.filter((h) => allowed.has(h.inboxItemId)) : raw;
      semanticStatus = 'ran';
    }

    // --- fuse ---
    const legs: LegRanking[] = [];
    if (semanticHits.length) {
      legs.push({ leg: 'semantic', order: semanticHits.map((h) => h.inboxItemId) });
    }
    if (keywordHits.length) {
      legs.push({ leg: 'keyword', order: keywordHits.map((h) => h.inboxItemId) });
    }
    const fused = fuseRankings(legs).slice(0, limit);

    const semById = new Map(semanticHits.map((h) => [h.inboxItemId, h]));
    const kwById = new Map(keywordHits.map((h) => [h.inboxItemId, h]));
    const meta = await this.loadItemMeta(
      userId,
      fused.map((f) => f.itemId),
    );

    const results: SearchResultItem[] = [];
    fused.forEach((f, index) => {
      const m = meta.get(f.itemId);
      if (!m) return; // item deleted between legs and metadata load
      const sem = semById.get(f.itemId);
      const kw = kwById.get(f.itemId);
      results.push({
        itemId: f.itemId,
        title: m.title,
        sourceType: m.sourceType,
        occurredAt: m.occurredAt,
        // Prefer the keyword snippet (it carries <mark> highlights); fall back
        // to the semantic chunk text. Timestamps come from the semantic hit,
        // which alone knows the transcript segment window.
        snippet: kw?.snippet ?? sem?.text ?? null,
        snippetSource: kw?.source ?? sem?.source ?? null,
        startSeconds: sem?.startSeconds ?? null,
        endSeconds: sem?.endSeconds ?? null,
        semanticScore: sem ? round(sem.score, 4) : null,
        semanticRank: f.ranks.semantic ?? null,
        keywordScore: kw ? round(kw.score, 4) : null,
        keywordRank: f.ranks.keyword ?? null,
        fusedScore: round(f.fusedScore, 6),
        rank: index + 1,
        sensitivityTier: m.sensitivityTier,
      });
    });

    return {
      results,
      legs: { semantic: semanticStatus, keyword: keywordStatus, notes },
    };
  }

  /**
   * "More like this" (JJ-38): items nearest the source item's embedding
   * centroid (vector leg only). Empty with a clear reason when embeddings are
   * unconfigured or the item has no embeddings yet.
   */
  async similar(userId: string, itemId: string, limit = 10): Promise<SimilarResponse> {
    if (!(await this.embeddingSearch.isEnabled(userId))) {
      return {
        results: [],
        available: false,
        reason:
          'semantic search is unavailable because embeddings are not configured — add an AI provider and assign it to the embeddings capability in Settings → AI',
      };
    }

    const item = await this.items.findOne({ where: { id: itemId, userId } });
    if (!item) throw new NotFoundException('inbox item not found');

    const sourceCount = await this.chunks.count({ where: { userId, inboxItemId: itemId } });
    if (sourceCount === 0) {
      return {
        results: [],
        available: true,
        reason: 'this item has no embeddings yet — nothing to compare against',
      };
    }

    const driver = this.chunks.manager.connection.options.type;
    const hits =
      driver === 'postgres'
        ? await this.similarPostgres(userId, itemId, limit)
        : await this.similarInMemory(userId, itemId, limit);

    if (hits.length === 0) {
      return { results: [], available: true, reason: 'no similar items found' };
    }

    const meta = await this.loadItemMeta(
      userId,
      hits.map((h) => h.inboxItemId),
    );
    const results: SimilarItem[] = [];
    for (const hit of hits) {
      const m = meta.get(hit.inboxItemId);
      if (!m) continue;
      results.push({
        itemId: hit.inboxItemId,
        title: m.title,
        sourceType: m.sourceType,
        occurredAt: m.occurredAt,
        snippet: hit.text,
        snippetSource: hit.source,
        startSeconds: hit.startSeconds,
        endSeconds: hit.endSeconds,
        score: round(hit.score, 4),
      });
    }
    return { results, available: true, reason: null };
  }

  // ---- filters ----

  /**
   * The set of item ids permitted by the structured filters (intersection of
   * every dimension present). Returns an empty set when a dimension matches
   * nothing, which the callers short-circuit on.
   */
  private async resolveAllowedItems(
    userId: string,
    filters: SearchFilters,
  ): Promise<Set<string>> {
    const sets: Set<string>[] = [];

    // sourceType + date range come straight off the inbox item.
    if (filters.sourceType || filters.from || filters.to) {
      const where: Record<string, unknown> = { userId };
      if (filters.sourceType) where.sourceType = filters.sourceType;
      if (filters.from && filters.to) {
        // occurredAt is an ISO-8601 string column; Between is inclusive and
        // lexicographic comparison of ISO strings is chronological.
        where.occurredAt = Between(filters.from, filters.to);
      } else if (filters.from) {
        where.occurredAt = MoreThanOrEqual(filters.from);
      } else if (filters.to) {
        where.occurredAt = LessThanOrEqual(filters.to);
      }
      const rows = await this.items.find({ select: { id: true }, where });
      sets.push(new Set(rows.map((r) => r.id)));
    }

    if (filters.entityId) {
      const rows = await this.mentions.find({
        select: { inboxItemId: true },
        where: { userId, entityId: filters.entityId },
      });
      sets.push(new Set(rows.map((r) => r.inboxItemId)));
    }

    if (filters.topicId) {
      const rows = await this.itemTopics.find({
        select: { inboxItemId: true },
        where: { userId, topicId: filters.topicId },
      });
      sets.push(new Set(rows.map((r) => r.inboxItemId)));
    }

    if (sets.length === 0) return new Set();
    // Intersect: start from the smallest set for cheapness.
    sets.sort((a, b) => a.size - b.size);
    let acc = sets[0];
    for (let i = 1; i < sets.length; i++) {
      acc = new Set([...acc].filter((id) => sets[i].has(id)));
      if (acc.size === 0) break;
    }
    return acc;
  }

  /** Filter-only browse: the allowed items, newest first. */
  private async browseByFilter(
    userId: string,
    allowed: Set<string> | null,
    limit: number,
  ): Promise<SearchResultItem[]> {
    const where: Record<string, unknown> = { userId };
    if (allowed) where.id = In([...allowed]);
    const rows = await this.items.find({
      where,
      relations: { extractions: true },
      order: { occurredAt: 'DESC' },
      take: limit,
    });
    const tiers = await this.loadSensitivityTiers(rows.map((r) => r.id));
    return rows.map((item, index) => ({
      itemId: item.id,
      title: titleOf(item),
      sourceType: item.sourceType,
      occurredAt: item.occurredAt,
      snippet: null,
      snippetSource: null,
      startSeconds: null,
      endSeconds: null,
      semanticScore: null,
      semanticRank: null,
      keywordScore: null,
      keywordRank: null,
      fusedScore: 0,
      rank: index + 1,
      sensitivityTier: tiers.get(item.id) ?? null,
    }));
  }

  // ---- similar (vector) legs ----

  private async similarPostgres(
    userId: string,
    itemId: string,
    limit: number,
  ): Promise<EmbeddingSearchHit[]> {
    const rows: Array<{
      inboxItemId: string;
      source: EmbeddingChunkSource;
      text: string;
      startSeconds: number | null;
      endSeconds: number | null;
      distance: number | string;
    }> = await this.chunks.query(
      `WITH centroid AS (
         SELECT AVG(embedding) AS vec
         FROM embedding_chunks WHERE "userId" = $1 AND "inboxItemId" = $2
       )
       SELECT best."inboxItemId", best.source, best.text,
              best."startSeconds", best."endSeconds", best.distance
       FROM (
         SELECT DISTINCT ON (c."inboxItemId")
           c."inboxItemId", c.source, c.text, c."startSeconds", c."endSeconds",
           (c.embedding <=> (SELECT vec FROM centroid)) AS distance
         FROM embedding_chunks c
         WHERE c."userId" = $1 AND c."inboxItemId" <> $2
         ORDER BY c."inboxItemId", distance ASC
       ) best
       ORDER BY best.distance ASC
       LIMIT $3`,
      [userId, itemId, limit],
    );
    return rows.map((row) => ({
      inboxItemId: row.inboxItemId,
      chunkId: '',
      source: row.source,
      text: row.text,
      startSeconds: row.startSeconds,
      endSeconds: row.endSeconds,
      score: 1 - Number(row.distance),
    }));
  }

  private async similarInMemory(
    userId: string,
    itemId: string,
    limit: number,
  ): Promise<EmbeddingSearchHit[]> {
    const all = await this.chunks.find({ where: { userId } });
    const sourceVectors = all.filter((c) => c.inboxItemId === itemId).map((c) => c.embedding);
    if (sourceVectors.length === 0) return [];
    const centroid = averageVector(sourceVectors);

    const bestPerItem = new Map<string, EmbeddingSearchHit>();
    for (const chunk of all) {
      if (chunk.inboxItemId === itemId) continue;
      if (chunk.embedding.length !== centroid.length) continue;
      const score = cosineSimilarity(centroid, chunk.embedding);
      const existing = bestPerItem.get(chunk.inboxItemId);
      if (!existing || score > existing.score) {
        bestPerItem.set(chunk.inboxItemId, {
          inboxItemId: chunk.inboxItemId,
          chunkId: chunk.id,
          source: chunk.source,
          text: chunk.text,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          score,
        });
      }
    }
    return [...bestPerItem.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---- item metadata ----

  private async loadItemMeta(userId: string, itemIds: string[]): Promise<Map<string, ItemMeta>> {
    if (itemIds.length === 0) return new Map();
    const rows = await this.items.find({
      where: { id: In(itemIds), userId },
      relations: { extractions: true },
    });
    const tiers = await this.loadSensitivityTiers(itemIds);
    return new Map(
      rows.map((item) => [
        item.id,
        {
          itemId: item.id,
          title: titleOf(item),
          sourceType: item.sourceType,
          occurredAt: item.occurredAt,
          sensitivityTier: tiers.get(item.id) ?? null,
        },
      ]),
    );
  }

  /**
   * Effective sensitivity tier per item (JJ-21) — a user's `manualTier`
   * override folded over the classifier's `detectedTier`. Missing rows mean
   * the item is unclassified (→ null).
   */
  private async loadSensitivityTiers(
    itemIds: string[],
  ): Promise<Map<string, SensitivityTier>> {
    const map = new Map<string, SensitivityTier>();
    if (itemIds.length === 0) return map;
    const rows = await this.sensitivity.find({ where: { inboxItemId: In(itemIds) } });
    for (const row of rows) map.set(row.inboxItemId, row.manualTier ?? row.detectedTier);
    return map;
  }
}

function statusForSemantic(enabled: boolean): SearchLegStatus {
  return enabled ? 'ran' : 'unavailable';
}

function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function titleOf(item: InboxItemEntity): string | null {
  const tags = (item.metadata?.tags as Record<string, unknown> | undefined) ?? undefined;
  const tagTitle = typeof tags?.title === 'string' ? tags.title : null;
  if (tagTitle) return tagTitle;
  const summary = latestSummary(item.extractions ?? []);
  return summary?.title ?? null;
}

function latestSummary(
  extractions: ExtractedPayloadEntity[],
): { title: string } | null {
  const row = extractions
    .filter((e) => e.kind === 'summary' && e.status === 'succeeded' && e.content)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  if (!row?.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(row.content));
    return parsed.success ? { title: parsed.data.title } : null;
  } catch {
    return null;
  }
}

function averageVector(vectors: number[][]): number[] {
  const dims = vectors[0].length;
  const acc = new Array<number>(dims).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dims; i++) acc[i] += v[i];
  }
  for (let i = 0; i < dims; i++) acc[i] /= vectors.length;
  return acc;
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

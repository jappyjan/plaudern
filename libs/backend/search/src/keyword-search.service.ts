import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EmbeddingChunkSource } from '@plaudern/contracts';
import { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';

/** One keyword-leg hit: the best-matching payload of a distinct inbox item. */
export interface KeywordHit {
  inboxItemId: string;
  /** Which derived artifact matched (transcript or summary). */
  source: EmbeddingChunkSource;
  /** A highlighted passage (`<mark>…</mark>`) around the match. */
  snippet: string;
  /** Relevance score (ts_rank on Postgres; a term-frequency proxy in memory). */
  score: number;
}

/**
 * Payload kinds whose text is searchable and their snippet source label. OCR
 * text (scanned documents, JJ-83) is indexed alongside transcripts and reported
 * under the same `'transcript'` source — it is the item's primary recognized
 * text, just read from a page instead of speech.
 */
const SEARCHABLE_KINDS: Record<string, EmbeddingChunkSource> = {
  transcription: 'transcript',
  ocr: 'transcript',
  summary: 'summary',
};

/** The kinds the keyword leg indexes, derived from the label map above. */
const SEARCHABLE_KIND_LIST = Object.keys(SEARCHABLE_KINDS);

/**
 * The keyword (full-text-search) leg of hybrid search. On Postgres it uses the
 * `search_vector` generated tsvector column + GIN index provisioned by the
 * `…026-AddFullTextSearch` migration (config `'simple'`, chosen for bilingual
 * DE/EN content — see that migration). On the sqlite test database (no FTS) it
 * falls back to an in-JS term scan, mirroring how `EmbeddingSearchService`
 * keeps the semantic leg driver-agnostic.
 *
 * Indexing the always-present transcript/summary payloads (not embedding chunks)
 * is deliberate: this leg must keep working when the embeddings provider is
 * unconfigured and no chunks exist. Every query is scoped to `userId` and
 * collapsed to one hit per inbox item (its best-scoring payload).
 */
@Injectable()
export class KeywordSearchService {
  constructor(
    @InjectRepository(ExtractedPayloadEntity)
    private readonly payloads: Repository<ExtractedPayloadEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {}

  /**
   * @param allowedItemIds when non-null, restrict to these item ids (the
   *   structured-filter pre-filter); an empty set yields no hits.
   */
  async search(
    userId: string,
    queryText: string,
    limit: number,
    allowedItemIds: Set<string> | null,
  ): Promise<KeywordHit[]> {
    const trimmed = queryText.trim();
    if (!trimmed) return [];
    if (allowedItemIds && allowedItemIds.size === 0) return [];

    const driver = this.payloads.manager.connection.options.type;
    return driver === 'postgres'
      ? this.searchPostgres(userId, trimmed, limit, allowedItemIds)
      : this.searchInMemory(userId, trimmed, limit, allowedItemIds);
  }

  /**
   * Native FTS: `websearch_to_tsquery` (gives users quoted phrases and `-`
   * negation) against the GIN-indexed generated column, ranked by `ts_rank`,
   * one best payload per item via DISTINCT ON, with a `ts_headline` snippet.
   */
  private async searchPostgres(
    userId: string,
    queryText: string,
    limit: number,
    allowedItemIds: Set<string> | null,
  ): Promise<KeywordHit[]> {
    const params: unknown[] = [queryText, userId];
    let allowedClause = '';
    if (allowedItemIds) {
      params.push([...allowedItemIds]);
      allowedClause = `AND p."inboxItemId" = ANY($${params.length}::uuid[])`;
    }
    params.push(limit);
    const limitParam = `$${params.length}`;

    const rows: Array<{
      inboxItemId: string;
      kind: string;
      score: number | string;
      snippet: string;
    }> = await this.payloads.query(
      `SELECT best."inboxItemId", best.kind, best.score, best.snippet
       FROM (
         SELECT DISTINCT ON (p."inboxItemId")
           p."inboxItemId",
           p.kind,
           ts_rank(p.search_vector, websearch_to_tsquery('simple', $1)) AS score,
           ts_headline(
             'simple', coalesce(p.content, ''), websearch_to_tsquery('simple', $1),
             'StartSel=<mark>,StopSel=</mark>,MaxWords=40,MinWords=15,MaxFragments=1,ShortWord=2'
           ) AS snippet
         FROM extracted_payloads p
         JOIN inbox_items i ON i.id = p."inboxItemId"
         WHERE i."userId" = $2
           AND p.status = 'succeeded'
           AND p.kind IN ('transcription', 'ocr', 'summary')
           AND p.search_vector @@ websearch_to_tsquery('simple', $1)
           ${allowedClause}
         ORDER BY p."inboxItemId", score DESC
       ) best
       ORDER BY best.score DESC
       LIMIT ${limitParam}`,
      params,
    );

    return rows.map((row) => ({
      inboxItemId: row.inboxItemId,
      source: SEARCHABLE_KINDS[row.kind] ?? 'summary',
      snippet: row.snippet,
      score: Number(row.score),
    }));
  }

  /**
   * Portable fallback for sqlite (no FTS): load the user's succeeded
   * transcript/summary payloads and score them by how many query terms they
   * contain (term frequency as a tie-breaker), then keep the best payload per
   * item. Fine at test scale; production runs the native path above.
   */
  private async searchInMemory(
    userId: string,
    queryText: string,
    limit: number,
    allowedItemIds: Set<string> | null,
  ): Promise<KeywordHit[]> {
    const terms = tokenize(queryText);
    if (terms.length === 0) return [];

    const rows = await this.payloads
      .createQueryBuilder('p')
      .innerJoin(InboxItemEntity, 'i', 'i.id = p.inboxItemId')
      .where('i.userId = :userId', { userId })
      .andWhere('p.status = :status', { status: 'succeeded' })
      .andWhere('p.kind IN (:...kinds)', { kinds: SEARCHABLE_KIND_LIST })
      .getMany();

    const bestPerItem = new Map<string, KeywordHit & { _score: number }>();
    for (const row of rows) {
      if (allowedItemIds && !allowedItemIds.has(row.inboxItemId)) continue;
      const content = row.content ?? '';
      if (!content) continue;
      const score = termScore(content, terms);
      if (score <= 0) continue;
      const existing = bestPerItem.get(row.inboxItemId);
      if (existing && existing._score >= score) continue;
      bestPerItem.set(row.inboxItemId, {
        inboxItemId: row.inboxItemId,
        source: SEARCHABLE_KINDS[row.kind] ?? 'summary',
        snippet: highlightSnippet(content, terms),
        score,
        _score: score,
      });
    }

    return [...bestPerItem.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ _score, ...hit }) => hit);
  }
}

/** Lowercased alphanumeric terms (≥2 chars), diacritics folded for matching. */
export function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length >= 2);
}

const COMBINING_MARKS = /[̀-ͯ]/g;

function fold(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '');
}

/** Total occurrences of any query term in the text (0 = no match). */
function termScore(content: string, terms: string[]): number {
  const hay = fold(content);
  let total = 0;
  for (const term of terms) {
    let idx = hay.indexOf(term);
    while (idx !== -1) {
      total += 1;
      idx = hay.indexOf(term, idx + term.length);
    }
  }
  return total;
}

/**
 * A window of the original text around the first matched term, with every term
 * occurrence wrapped in `<mark>`. Operates on folded indices but slices the
 * original text so display keeps its original casing and diacritics.
 */
export function highlightSnippet(content: string, terms: string[], window = 160): string {
  const hay = fold(content);
  let first = -1;
  for (const term of terms) {
    const idx = hay.indexOf(term);
    if (idx !== -1 && (first === -1 || idx < first)) first = idx;
  }
  if (first === -1) return content.slice(0, window);

  const start = Math.max(0, first - Math.floor(window / 3));
  const end = Math.min(content.length, start + window);
  let slice = content.slice(start, end);

  // Highlight term occurrences within the slice (case/diacritic-insensitive).
  const sliceFold = fold(slice);
  const marks: Array<[number, number]> = [];
  for (const term of terms) {
    let idx = sliceFold.indexOf(term);
    while (idx !== -1) {
      marks.push([idx, idx + term.length]);
      idx = sliceFold.indexOf(term, idx + term.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  // Merge overlapping ranges, then splice markers back-to-front.
  const merged: Array<[number, number]> = [];
  for (const [s, e] of marks) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  for (let i = merged.length - 1; i >= 0; i--) {
    const [s, e] = merged[i];
    slice = `${slice.slice(0, s)}<mark>${slice.slice(s, e)}</mark>${slice.slice(e)}`;
  }

  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

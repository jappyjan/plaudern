import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  summaryPayloadSchema,
  type EmbeddingChunkSource,
  type SourceType,
} from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { InboxService } from '@plaudern/inbox';
import { EmbeddingSearchService } from '@plaudern/embeddings';
import { IngestionService } from '@plaudern/ingestion';

/** A single semantic-search hit as returned to an MCP client. */
export interface SearchMemoryResult {
  itemId: string;
  source: EmbeddingChunkSource;
  /** The matching snippet of transcript or summary. */
  snippet: string;
  /** Cosine similarity, rounded; higher is closer. */
  score: number;
  /** Segment window (seconds) for transcript hits; null for summary hits. */
  startSeconds: number | null;
  endSeconds: number | null;
}

/** The full detail of one memory item. */
export interface GetItemResult {
  itemId: string;
  sourceType: SourceType;
  occurredAt: string;
  ingestedAt: string;
  title: string | null;
  transcript: string | null;
  summary: { title: string; layout: string; markdown: string } | null;
  /** User-supplied capture metadata (location, tags, source url, …). */
  metadata: Record<string, unknown> | null;
}

/** A compact list entry for recent-items listing. */
export interface RecentItemResult {
  itemId: string;
  sourceType: SourceType;
  occurredAt: string;
  ingestedAt: string;
  title: string | null;
  hasTranscript: boolean;
  hasSummary: boolean;
}

/**
 * The backing logic for the four MCP tools. Deliberately transport-agnostic:
 * these are plain async methods taking the acting `userId` plus already-parsed
 * arguments, so they are unit-testable without an MCP client and are reused by
 * `mcp.server.ts` (which only adapts them to the SDK's tool interface).
 *
 * Every method scopes its work to `userId` — retrieval, item fetch and capture
 * all inherit the token owner's permissions and can never touch another user's
 * memory. Responses carry content only (transcripts, summaries, snippets); they
 * never expose storage keys, tokens or other internal pointers.
 */
@Injectable()
export class McpToolsService {
  constructor(
    private readonly inbox: InboxService,
    private readonly search: EmbeddingSearchService,
    private readonly ingestion: IngestionService,
  ) {}

  /** search_memory: semantic search over the user's transcript/summary chunks. */
  async searchMemory(
    userId: string,
    args: { query: string; limit: number },
  ): Promise<SearchMemoryResult[]> {
    const hits = await this.search.search(userId, args.query, args.limit);
    return hits.map((hit) => ({
      itemId: hit.inboxItemId,
      source: hit.source,
      snippet: hit.text,
      score: Math.round(hit.score * 1000) / 1000,
      startSeconds: hit.startSeconds,
      endSeconds: hit.endSeconds,
    }));
  }

  /** get_item: full transcript, summary and metadata for one item. */
  async getItem(userId: string, args: { itemId: string }): Promise<GetItemResult> {
    const item = await this.inbox.getItem(userId, args.itemId);
    const transcription = latestSucceeded(item, 'transcription');
    const summary = parseSummary(latestSucceeded(item, 'summary'));
    return {
      itemId: item.id,
      sourceType: item.sourceType,
      occurredAt: toIso(item.occurredAt),
      ingestedAt: toIso(item.ingestedAt),
      title: titleOf(item, summary),
      transcript: transcription?.content ?? null,
      summary: summary
        ? { title: summary.title, layout: summary.layout, markdown: summary.markdown }
        : null,
      metadata: item.metadata ?? null,
    };
  }

  /** list_recent_items: newest-first page of the user's memory. */
  async listRecentItems(
    userId: string,
    args: { limit: number; cursor?: string },
  ): Promise<{ items: RecentItemResult[]; nextCursor: string | null }> {
    const { items, nextCursor } = await this.inbox.listItems(userId, args.limit, args.cursor);
    return {
      items: items.map((item) => {
        const summary = parseSummary(latestSucceeded(item, 'summary'));
        return {
          itemId: item.id,
          sourceType: item.sourceType,
          occurredAt: toIso(item.occurredAt),
          ingestedAt: toIso(item.ingestedAt),
          title: titleOf(item, summary),
          hasTranscript: Boolean(latestSucceeded(item, 'transcription')?.content),
          hasSummary: Boolean(summary),
        };
      }),
      nextCursor,
    };
  }

  /**
   * ingest_text_note: capture a plain-text note into the inbox (same path the
   * web app uses). `occurredAt` defaults to now and `idempotencyKey` to a fresh
   * UUID, so repeat calls create distinct notes unless the caller pins a key.
   */
  async ingestTextNote(
    userId: string,
    args: { text: string; occurredAt?: string; idempotencyKey?: string },
  ): Promise<{ itemId: string }> {
    const item = await this.ingestion.ingestText(userId, {
      text: args.text,
      occurredAt: args.occurredAt ?? new Date().toISOString(),
      idempotencyKey: args.idempotencyKey ?? `mcp-note-${randomUUID()}`,
    });
    return { itemId: item.id };
  }
}

function latestSucceeded(
  item: InboxItemEntity,
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return (item.extractions ?? [])
    .filter((e) => e.kind === kind && e.status === 'succeeded')
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function parseSummary(
  extraction: ExtractedPayloadEntity | undefined,
): { title: string; layout: string; markdown: string } | null {
  if (!extraction?.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(extraction.content));
    if (!parsed.success) return null;
    return {
      title: parsed.data.title,
      layout: parsed.data.layout,
      markdown: parsed.data.markdown,
    };
  } catch {
    return null;
  }
}

function titleOf(
  item: InboxItemEntity,
  summary: { title: string } | null,
): string | null {
  const tags = (item.metadata?.tags as Record<string, unknown> | undefined) ?? undefined;
  const tagTitle = typeof tags?.title === 'string' ? tags.title : null;
  return tagTitle ?? summary?.title ?? null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

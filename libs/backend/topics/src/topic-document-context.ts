import { summaryPayloadSchema, type TopicDocumentCitation } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { buildTopicContent } from './topic-context';

/** Upper bound on source items fed to one generation, newest kept when over. */
export const DEFAULT_MAX_SOURCE_ITEMS = 40;
/** Per-item excerpt length — enough to carry the substance, small enough to stay cheap. */
export const DEFAULT_MAX_ITEM_CHARS = 1_500;
/** Snippet length stored on each citation for the UI preview. */
const SNIPPET_CHARS = 240;

/** One classifiable source item, numbered for the generator and for citations. */
export interface TopicDocumentSourceItem {
  marker: number;
  inboxItemId: string;
  title: string | null;
  occurredAt: string;
  text: string;
  language?: string;
  snippet: string;
}

export interface CollectSourcesOptions {
  maxItems?: number;
  maxItemChars?: number;
}

/**
 * Turn a topic's classified inbox items into the numbered, oldest-first source
 * list a living-document generation runs over. Each item contributes its
 * densest text (summary preferred, transcript otherwise) via `buildTopicContent`;
 * items with neither are skipped. When there are more items than `maxItems`, the
 * most recent ones are kept (a living document leans on what's current) and then
 * re-sorted oldest-first so markers follow the timeline.
 */
export function collectTopicDocumentSources(
  items: InboxItemEntity[],
  options: CollectSourcesOptions = {},
): TopicDocumentSourceItem[] {
  const maxItems = options.maxItems ?? DEFAULT_MAX_SOURCE_ITEMS;
  const maxItemChars = options.maxItemChars ?? DEFAULT_MAX_ITEM_CHARS;

  const withContent = items
    .map((item) => {
      const content = buildTopicContent(item, maxItemChars);
      if (!content) return null;
      return {
        inboxItemId: item.id,
        occurredAt: iso(item.occurredAt),
        title: itemTitle(item),
        text: content.content,
        language: content.language,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  // Oldest-first for a coherent timeline.
  withContent.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

  // When over budget keep the most recent items, then restore oldest-first order.
  const bounded =
    withContent.length > maxItems ? withContent.slice(withContent.length - maxItems) : withContent;

  return bounded.map((s, index) => ({
    marker: index + 1,
    inboxItemId: s.inboxItemId,
    title: s.title,
    occurredAt: s.occurredAt,
    text: s.text,
    language: s.language,
    snippet: s.text.slice(0, SNIPPET_CHARS).trim(),
  }));
}

/** Build the structural citation for a source item at the given marker. */
export function toCitation(source: TopicDocumentSourceItem): TopicDocumentCitation {
  return {
    marker: source.marker,
    inboxItemId: source.inboxItemId,
    title: source.title,
    occurredAt: source.occurredAt,
    snippet: source.snippet || null,
    // Documents are built from item-level text (summaries), not a single
    // transcript segment, so there is no audio offset — the deep link opens the
    // item. `startSeconds` stays null, exactly like a summary-sourced chat citation.
    startSeconds: null,
    endSeconds: null,
  };
}

/**
 * The set of source markers actually referenced by the body, keeping only
 * in-range `[n]` markers (1..sourceCount). Out-of-range markers are ignored so
 * a hallucinated number never yields a citation.
 */
export function usedMarkers(markdown: string, sourceCount: number): Set<number> {
  const used = new Set<number>();
  for (const match of markdown.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= sourceCount) used.add(n);
  }
  return used;
}

/**
 * Strip inline `[n]` markers that point outside the provided source range so a
 * hallucinated citation can never render as a chip. In-range markers are left
 * intact for the renderer to resolve.
 */
export function sanitizeMarkers(markdown: string, sourceCount: number): string {
  return markdown.replace(/\[(\d{1,3})\]/g, (whole, digits) => {
    const n = Number(digits);
    return n >= 1 && n <= sourceCount ? whole : '';
  });
}

/** The latest succeeded summary's title, when one exists; null otherwise. */
function itemTitle(item: InboxItemEntity): string | null {
  const summary = latestOfKind(item.extractions ?? [], 'summary');
  if (summary?.status !== 'succeeded' || !summary.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(summary.content));
    return parsed.success ? parsed.data.title : null;
  } catch {
    return null;
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

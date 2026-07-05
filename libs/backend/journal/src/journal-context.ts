import {
  summaryPayloadSchema,
  type JournalCitation,
  type JournalCitationKind,
} from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { MARKER_RE, MARKER_RUN_RE } from '@plaudern/citations';

/** Upper bound on source signals fed to one generation (keeps the prompt bounded). */
export const DEFAULT_MAX_SOURCES = 60;
/** Per-source excerpt length — enough substance, small enough to stay cheap. */
export const DEFAULT_MAX_SOURCE_CHARS = 1_200;
/** Snippet length stored on each citation for the UI preview. */
const SNIPPET_CHARS = 240;
/** Preview length shown in the period list. */
const PREVIEW_CHARS = 200;

/**
 * A raw source signal gathered for a period, before numbering. `kind` decides
 * how a citation deep-links (inbox item, calendar event, or a daily entry when
 * rolling up).
 */
export interface RawJournalSource {
  kind: JournalCitationKind;
  refId: string;
  title: string | null;
  /** ISO 8601 occurrence time — sources are ordered by this so the day reads chronologically. */
  occurredAt: string;
  /** The text handed to the model. */
  text: string;
  /** Audio deep-link offset for item sources when known; null otherwise. */
  startSeconds: number | null;
}

/** A numbered source: a raw source assigned its `[n]` marker and citation snippet. */
export interface JournalSource extends RawJournalSource {
  marker: number;
  snippet: string;
}

/**
 * Order raw sources oldest-first (chronological narrative), cap to `maxSources`
 * keeping the most recent when over budget, then assign 1-based markers and
 * derive each citation snippet. Returns sources ready for both the prompt and
 * the stored citation list.
 */
export function numberSources(
  raw: RawJournalSource[],
  maxSources: number = DEFAULT_MAX_SOURCES,
): JournalSource[] {
  const sorted = [...raw].sort((a, b) =>
    a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0,
  );
  const bounded = sorted.length > maxSources ? sorted.slice(sorted.length - maxSources) : sorted;
  return bounded.map((s, index) => ({
    ...s,
    marker: index + 1,
    snippet: s.text.slice(0, SNIPPET_CHARS).trim(),
  }));
}

/** Build the structural citation for a numbered source. */
export function toJournalCitation(source: JournalSource): JournalCitation {
  return {
    marker: source.marker,
    kind: source.kind,
    refId: source.refId,
    title: source.title,
    occurredAt: source.occurredAt,
    snippet: source.snippet || null,
    startSeconds: source.startSeconds,
    endSeconds: null,
  };
}

/**
 * Densest text for an inbox item: its latest succeeded summary (title +
 * markdown) preferred, else the transcript, truncated. Returns null when the
 * item has neither usable extraction yet.
 */
export function buildItemText(
  item: InboxItemEntity,
  maxChars: number = DEFAULT_MAX_SOURCE_CHARS,
): string | null {
  const extractions = item.extractions ?? [];
  const summary = latestOfKind(extractions, 'summary');
  if (summary?.status === 'succeeded' && summary.content) {
    const text = summaryText(summary.content);
    if (text) return truncate(text, maxChars);
  }
  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content?.trim()) {
    return truncate(transcription.content.trim(), maxChars);
  }
  return null;
}

/** The latest succeeded summary's title for an item, when one exists. */
export function itemTitle(item: InboxItemEntity): string | null {
  const summary = latestOfKind(item.extractions ?? [], 'summary');
  if (summary?.status !== 'succeeded' || !summary.content) return null;
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(summary.content));
    return parsed.success ? parsed.data.title : null;
  } catch {
    return null;
  }
}

function summaryText(content: string): string {
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return '';
    const { title, markdown, offTopic } = parsed.data;
    return [title, markdown, offTopic ?? ''].filter(Boolean).join('\n\n').trim();
  } catch {
    return '';
  }
}

/**
 * Identifier-guarded citation matchers, mirroring the memory-chat citation
 * enforcer and the living topic documents so all three cited artifacts share
 * ONE positioning contract: a citation site is a RUN of `[n]` groups whose
 * first bracket is NOT immediately preceded by an identifier character or a
 * closing bracket/paren. That keeps code/array indices out of citation handling
 * entirely — `array[99]` and `arr[1][2]` in prose are never treated as
 * citations — while "… today. [3]", a leading "[1] …" and chained "… run [1][2]."
 * remain citations.
 *
 * Like the living documents (and unlike chat's `enforceCitations`) we do NOT
 * renumber survivors: the journal keeps each source's ORIGINAL marker so the
 * body stays aligned with the numbered source list and its citation chips.
 *
 * The regexes are the shared `@plaudern/citations` matchers — one positioning
 * contract, defined once — but the sanitize/`usedMarkers` logic stays local
 * because it must keep original numbers rather than renumber.
 */

/** The set of in-range source markers actually cited by the body. */
export function usedMarkers(markdown: string, sourceCount: number): Set<number> {
  const used = new Set<number>();
  for (const run of markdown.match(MARKER_RUN_RE) ?? []) {
    for (const match of run.matchAll(MARKER_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= sourceCount) used.add(n);
    }
  }
  return used;
}

/**
 * Strip inline `[n]` markers pointing outside the provided source range so a
 * hallucinated citation can never render as a chip. Only markers at a citation
 * position are touched; in-range markers keep their original numbers.
 */
export function sanitizeMarkers(markdown: string, sourceCount: number): string {
  return markdown.replace(MARKER_RUN_RE, (run) =>
    run.replace(MARKER_RE, (whole, digits: string) => {
      const n = Number(digits);
      return n >= 1 && n <= sourceCount ? whole : '';
    }),
  );
}

/**
 * A short, marker-free, heading-free lede of an entry for the period list — the
 * first substantive line of prose.
 */
export function previewOf(markdown: string | null): string | null {
  if (!markdown) return null;
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine
      .replace(MARKER_RUN_RE, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*>]\s+/, '')
      .replace(/[*_`#]/g, '')
      // Collapse runs of whitespace and tidy the space a stripped marker leaves
      // before punctuation (e.g. "happened [1]." → "happened.").
      .replace(/\s+/g, ' ')
      .replace(/\s+([.,;:!?])/g, '$1')
      .trim();
    if (line) return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS).trim()}…` : line;
  }
  return null;
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

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

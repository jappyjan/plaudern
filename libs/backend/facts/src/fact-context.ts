import { summaryPayloadSchema } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { FactExtractionInput, FactKnownPerson } from './facts.provider';

/** Upper bound on the analyzed text so a long transcript can't blow the context window. */
export const DEFAULT_MAX_CHARS = 8_000;

/**
 * Assemble the text a `facts` extraction runs over from an item's append-only
 * extractions. Prefers the latest succeeded transcription (the raw words carry
 * the personal detail — names, relationships, offhand facts) and falls back to
 * the summary; combines both when available for the densest signal. Returns null
 * when the item has neither succeeded, so the processor fails the job cleanly.
 * The required-transcription dependency normally prevents that, but the
 * processor guards defensively. `knownPeople` is supplied by the processor.
 */
export function buildFactExtractionInput(
  item: InboxItemEntity,
  knownPeople: FactKnownPerson[] = [],
  maxChars: number = DEFAULT_MAX_CHARS,
): FactExtractionInput | null {
  const extractions = item.extractions ?? [];

  const transcription = latestOfKind(extractions, 'transcription');
  const transcript =
    transcription?.status === 'succeeded' ? transcription.content?.trim() ?? '' : '';

  const summary = latestOfKind(extractions, 'summary');
  const summaryProse =
    summary?.status === 'succeeded' && summary.content ? summaryText(summary.content) : '';

  // Prefer the transcript (richest source of personal detail); prepend the
  // summary when present so a long transcript's key points survive truncation.
  const combined = [summaryProse, transcript].filter(Boolean).join('\n\n').trim();
  if (!combined) return null;

  return {
    text: truncate(combined, maxChars),
    knownPeople,
    language: transcription?.language ?? undefined,
    occurredAt: iso(item.occurredAt),
  };
}

/** Flatten a stored summary payload (JSON) into prose. */
function summaryText(content: string): string {
  try {
    const parsed = summaryPayloadSchema.safeParse(JSON.parse(content));
    if (!parsed.success) return '';
    const { title, markdown } = parsed.data;
    return [title, markdown].filter(Boolean).join('\n\n').trim();
  } catch {
    return '';
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
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

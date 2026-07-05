import { summaryPayloadSchema } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { TaskExtractionInput } from './tasks.provider';

/** Upper bound on the analyzed text so a long transcript can't blow the context window. */
export const DEFAULT_MAX_CHARS = 8_000;

/**
 * Assemble the text a `tasks` extraction runs over from an item's append-only
 * extractions. Prefers the latest succeeded summary (title + markdown — the
 * densest signal for spotting intentions) and falls back to the raw
 * transcription. Returns null when the item has neither succeeded, so the
 * processor can fail the job cleanly. The required-transcription dependency
 * normally prevents that, but the processor guards defensively.
 */
export function buildTaskExtractionInput(
  item: InboxItemEntity,
  maxChars: number = DEFAULT_MAX_CHARS,
): TaskExtractionInput | null {
  const extractions = item.extractions ?? [];

  const summary = latestOfKind(extractions, 'summary');
  if (summary?.status === 'succeeded' && summary.content) {
    const text = summaryText(summary.content);
    if (text) {
      return { text: truncate(text, maxChars), occurredAt: iso(item.occurredAt) };
    }
  }

  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content?.trim()) {
    return {
      text: truncate(transcription.content.trim(), maxChars),
      language: transcription.language ?? undefined,
      occurredAt: iso(item.occurredAt),
    };
  }

  return null;
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

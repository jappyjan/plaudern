import { summaryPayloadSchema } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';

/** Upper bound on the classified text so a long transcript can't blow the context window. */
export const DEFAULT_MAX_CHARS = 8_000;

export interface TopicContent {
  /** The text fed to the classifier. */
  content: string;
  /** Detected language of the source text, when known. */
  language?: string;
}

/**
 * Assemble the text a `topics` classification runs over. Prefers the latest
 * succeeded summary (title + markdown — the densest, cleanest signal) and falls
 * back to the raw transcription when no summary exists yet. Returns null when
 * the item has neither, so the processor can fail the job cleanly. The result
 * is truncated to `maxChars` to bound token usage.
 */
export function buildTopicContent(
  item: InboxItemEntity,
  maxChars: number = DEFAULT_MAX_CHARS,
): TopicContent | null {
  const extractions = item.extractions ?? [];

  const summary = latestOfKind(extractions, 'summary');
  if (summary?.status === 'succeeded' && summary.content) {
    const text = summaryText(summary.content);
    if (text) return { content: truncate(text, maxChars) };
  }

  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content?.trim()) {
    return {
      content: truncate(transcription.content.trim(), maxChars),
      language: transcription.language ?? undefined,
    };
  }

  return null;
}

/** Flatten a stored summary payload (JSON) into classifiable prose. */
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

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
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

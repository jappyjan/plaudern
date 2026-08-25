import { Injectable } from '@nestjs/common';
import { resolveSourceText } from '@plaudern/inbox';
import { InboxItemEntity } from '@plaudern/persistence';
import type { SentinelClassifyInput } from './sentinel.provider';

/** Upper bound on the transcript scanned, matching the reminders context cap. */
export const DEFAULT_MAX_CHARS = 20_000;

/**
 * Builds the sentinel classifier input from an item's text (JJ-21/JJ-85). It
 * uses the shared source-text policy: transcription for recordings and typed
 * text, OCR for scanned images/PDFs. This lets the sentinel classify document
 * content directly before it gates downstream text extractors. The context also
 * covers a BLANK scan (OCR succeeded with empty text): it yields an empty
 * transcript that classifies as `normal`, so those gated kinds proceed instead
 * of being held forever waiting for a tier that would otherwise never come.
 *
 * Returns null only when there is neither a succeeded transcription nor a
 * succeeded OCR row — genuinely nothing to classify yet.
 */
@Injectable()
export class SentinelContextService {
  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<SentinelClassifyInput | null> {
    const source = resolveSourceText(item, { allowBlank: true });
    if (!source) return null;
    return {
      transcript: truncate(source.text, maxChars),
      language: source.language,
      occurredAt: iso(item.occurredAt),
      // OCR-derived DOCUMENT text must never reach a non-local classifier.
      documentDerived: source.kind === 'ocr' ? true : undefined,
    };
  }
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

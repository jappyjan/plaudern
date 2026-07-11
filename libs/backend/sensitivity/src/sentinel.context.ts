import { Injectable } from '@nestjs/common';
import { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { SentinelClassifyInput } from './sentinel.provider';

/** Upper bound on the transcript scanned, matching the reminders context cap. */
export const DEFAULT_MAX_CHARS = 20_000;

/**
 * Builds the sentinel classifier input from an item's text (JJ-21/JJ-85). It
 * prefers the latest succeeded `transcription` — the passthrough-friendly source
 * the reminders extractor reads (typed notes, emails and web snapshots all carry
 * a passthrough transcription row, and OCR bridges recognized text into one too).
 *
 * For a scanned image/PDF it falls back to the latest succeeded `ocr` row's text
 * so the sentinel classifies the OCR-derived content DIRECTLY — the classifier
 * that gates `docmeta` and every downstream text extractor (JJ-85). This also
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
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status === 'succeeded' && transcription.content) {
      return {
        transcript: truncate(transcription.content, maxChars),
        language: transcription.language ?? undefined,
        occurredAt: iso(item.occurredAt),
      };
    }
    // Fall back to OCR-derived text: an image/PDF has no transcription of its
    // own (only a bridged one, which a blank scan never produces), so classify
    // the OCR output as soon as it exists — before docmeta/entities/… run.
    const ocr = latestOfKind(extractions, 'ocr');
    if (ocr?.status === 'succeeded') {
      return {
        transcript: truncate(ocr.content ?? '', maxChars),
        language: ocr.language ?? undefined,
        occurredAt: iso(item.occurredAt),
        // OCR-derived DOCUMENT text: the classifier must never send this to a
        // non-local endpoint (JJ-86 footgun guard in OpenAiSentinelProvider).
        documentDerived: true,
      };
    }
    return null;
  }
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
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

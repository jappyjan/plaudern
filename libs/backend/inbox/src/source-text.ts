import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';

/**
 * The text an item's downstream text extractors (entities, embeddings, topics,
 * keyword search) run over, and where it came from.
 */
export interface ResolvedSourceText {
  /** The extractable text itself. */
  text: string;
  /** Detected language of the source text, when known. */
  language?: string;
  /** Which extraction kind supplied the text. */
  kind: 'transcription' | 'ocr';
  /**
   * The extraction row the text came from, so callers that need more than the
   * text (e.g. the embedding chunker reading transcript `segments`) can reach
   * it without a second lookup.
   */
  extraction: ExtractedPayloadEntity;
}

/**
 * Resolve an item's extractable text: the latest succeeded `transcription` if
 * present, else the latest succeeded `ocr` text (JJ-83). This is the ONE place
 * entities/embeddings/topics agree on "what text do I run over", mirroring the
 * sentinel's transcription→OCR fallback (JJ-85) so a scanned document is
 * entity-linked and searchable like transcribed audio.
 *
 * Transcription is preferred, so audio items (and the OCR→transcription
 * passthrough bridge) resolve to exactly the same text as before — this only
 * adds the OCR fallback for items that carry no transcription at all. Returns
 * null when neither a succeeded transcription nor a succeeded OCR row with text
 * exists (a blank scan yields empty content and therefore nothing to run on).
 */
export function resolveSourceText(item: InboxItemEntity): ResolvedSourceText | null {
  const extractions = item.extractions ?? [];

  const transcription = latestOfKind(extractions, 'transcription');
  if (transcription?.status === 'succeeded' && transcription.content) {
    return {
      text: transcription.content,
      language: transcription.language ?? undefined,
      kind: 'transcription',
      extraction: transcription,
    };
  }

  const ocr = latestOfKind(extractions, 'ocr');
  if (ocr?.status === 'succeeded' && ocr.content) {
    return {
      text: ocr.content,
      language: ocr.language ?? undefined,
      kind: 'ocr',
      extraction: ocr,
    };
  }

  return null;
}

/**
 * Whether the item has a succeeded source-text extraction (transcription OR ocr)
 * to (re)run a downstream text extractor on. Status-only, mirroring the prior
 * transcription-only retry guards — the extractor's own processor still fails
 * cleanly if the succeeded row turns out to carry no text. Extends those guards
 * to accept a scanned document's OCR row (JJ-83).
 */
export function hasSucceededSourceExtraction(item: InboxItemEntity): boolean {
  const extractions = item.extractions ?? [];
  return (
    latestOfKind(extractions, 'transcription')?.status === 'succeeded' ||
    latestOfKind(extractions, 'ocr')?.status === 'succeeded'
  );
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

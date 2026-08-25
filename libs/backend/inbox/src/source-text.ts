import { hasDocumentPayload } from '@plaudern/contracts';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { ExtractorDependency } from './extractor';

export const SOURCE_TEXT_GROUP = 'sourceText';

export function sourceTextDependencies(): ExtractorDependency[] {
  return [
    { kind: 'transcription', requires: 'succeeded', group: SOURCE_TEXT_GROUP },
    { kind: 'ocr', requires: 'succeeded', group: SOURCE_TEXT_GROUP },
  ];
}

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
 * Resolve the one current text generation for an item. Document payloads use
 * OCR; every other committed payload uses transcription. The source-aware rule
 * keeps legacy OCR passthrough transcriptions from competing with OCR retries.
 * Source-less fixtures retain transcription-then-OCR fallback behavior.
 */
export function resolveSourceText(
  item: InboxItemEntity,
): ResolvedSourceText | null {
  const extractions = item.extractions ?? [];
  for (const kind of sourceTextKinds(item)) {
    const extraction = latestOfKind(extractions, kind);
    if (extraction?.status !== 'succeeded') continue;
    const text = extraction.content ?? '';
    if (text.trim().length === 0) continue;
    return {
      text,
      language: extraction.language ?? undefined,
      kind,
      extraction,
    };
  }
  return null;
}

/**
 * Whether the item has a nonblank current source-text generation to process.
 */
export function hasSucceededSourceExtraction(item: InboxItemEntity): boolean {
  return resolveSourceText(item) !== null;
}

export function sourceTextKinds(item: InboxItemEntity): Array<'transcription' | 'ocr'> {
  const contentType = item.source?.contentType;
  if (!contentType) return ['transcription', 'ocr'];
  return hasDocumentPayload(contentType) ? ['ocr'] : ['transcription'];
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

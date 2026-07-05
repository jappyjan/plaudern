import { Injectable } from '@nestjs/common';
import { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { DocMetaInput } from './docmeta.provider';

/** Upper bound on the OCR text fed to the model so a long document can't blow the context window. */
export const DEFAULT_MAX_CHARS = 16_000;

/**
 * Assembles the docmeta-extraction input for an item from its append-only
 * extractions: the latest succeeded `ocr` row's text plus the capture timestamp
 * (the anchor relative dates resolve against). Returns null when there is no
 * succeeded OCR text — docmeta has nothing to read without it.
 */
@Injectable()
export class DocMetaContextService {
  async build(
    item: InboxItemEntity,
    maxChars: number = DEFAULT_MAX_CHARS,
  ): Promise<DocMetaInput | null> {
    const ocr = latestOfKind(item.extractions ?? [], 'ocr');
    if (ocr?.status !== 'succeeded' || !ocr.content || !ocr.content.trim()) {
      return null;
    }
    return {
      text: truncate(ocr.content, maxChars),
      language: ocr.language ?? undefined,
      occurredAt: iso(item.occurredAt),
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

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

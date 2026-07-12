import { resolveSourceText } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import type { EntityExtractionInput } from './entities.provider';

/**
 * Assemble the entity-extraction input for an item from its append-only
 * extractions: the resolved source text (latest succeeded transcription, or the
 * OCR-recognized text for a scanned document — JJ-83) and its detected language,
 * plus the recording time. Returns null when there is no source text to extract
 * from — the source-text dependency group normally prevents that, but the
 * processor guards defensively.
 */
export function buildEntityExtractionInput(
  item: InboxItemEntity,
): EntityExtractionInput | null {
  const source = resolveSourceText(item);
  if (!source) return null;
  return {
    text: source.text,
    language: source.language,
    occurredAt: iso(item.occurredAt),
  };
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

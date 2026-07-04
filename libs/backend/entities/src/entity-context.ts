import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { EntityExtractionInput } from './entities.provider';

/**
 * Assemble the entity-extraction input for an item from its append-only
 * extractions: the latest succeeded transcription's text (and detected
 * language) plus the recording time. Returns null when there is no succeeded
 * transcription to extract from — the required transcription dependency
 * normally prevents that, but the processor guards defensively.
 */
export function buildEntityExtractionInput(
  item: InboxItemEntity,
): EntityExtractionInput | null {
  const transcription = latestOfKind(item.extractions ?? [], 'transcription');
  if (transcription?.status !== 'succeeded' || !transcription.content) {
    return null;
  }
  return {
    text: transcription.content,
    language: transcription.language ?? undefined,
    occurredAt: iso(item.occurredAt),
  };
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

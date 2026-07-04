import type {
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import type { RelationExtractionInput } from './relations.provider';

/**
 * Assemble the relation-extraction input for an item: the latest succeeded
 * transcription's text (and detected language), the recording time, and the
 * registry entities the item's latest `entities` extraction mentioned — the
 * only legal relation endpoints. Returns null when there is no succeeded
 * transcription to extract from — the DAG normally prevents that, but the
 * processor guards defensively.
 */
export function buildRelationExtractionInput(
  item: InboxItemEntity,
  entities: EntityRegistryEntity[],
): RelationExtractionInput | null {
  const transcription = latestOfKind(item.extractions ?? [], 'transcription');
  if (transcription?.status !== 'succeeded' || !transcription.content) {
    return null;
  }
  return {
    text: transcription.content,
    entities: entities.map((entity) => ({ name: entity.canonicalName, type: entity.type })),
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

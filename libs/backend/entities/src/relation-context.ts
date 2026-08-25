import { resolveSourceText } from '@plaudern/inbox';
import type { EntityRegistryEntity, InboxItemEntity } from '@plaudern/persistence';
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
  const source = resolveSourceText(item);
  if (!source) return null;
  return {
    text: source.text,
    entities: entities.map((entity) => ({ name: entity.canonicalName, type: entity.type })),
    language: source.language,
    occurredAt: iso(item.occurredAt),
  };
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

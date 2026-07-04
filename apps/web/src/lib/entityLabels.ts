import type { EntityType, RelationType } from '@plaudern/contracts';

/** Human-readable, singular labels for each entity type. */
export const ENTITY_TYPE_LABEL: Record<EntityType, string> = {
  person: 'Person',
  organization: 'Organization',
  place: 'Place',
  date: 'Date',
  amount: 'Amount',
  product: 'Product',
  medication: 'Medication',
  document_reference: 'Document',
};

/** Plural labels for section headings / filters. */
export const ENTITY_TYPE_LABEL_PLURAL: Record<EntityType, string> = {
  person: 'People',
  organization: 'Organizations',
  place: 'Places',
  date: 'Dates',
  amount: 'Amounts',
  product: 'Products',
  medication: 'Medications',
  document_reference: 'Documents',
};

/** All entity types in the order they should appear in filters and groupings. */
export const ENTITY_TYPES: EntityType[] = [
  'person',
  'organization',
  'place',
  'date',
  'amount',
  'product',
  'medication',
  'document_reference',
];

/** HeroUI chip colour per entity type — keeps a type recognizable everywhere. */
export const ENTITY_TYPE_COLOR: Record<
  EntityType,
  'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'danger'
> = {
  person: 'primary',
  organization: 'secondary',
  place: 'success',
  date: 'default',
  amount: 'warning',
  product: 'secondary',
  medication: 'danger',
  document_reference: 'default',
};

/** Human-readable labels for the constrained relation vocabulary. */
export const RELATION_TYPE_LABEL: Record<RelationType, string> = {
  works_at: 'Works at',
  located_in: 'Located in',
  involved_in: 'Involved in',
  discussed_with: 'Discussed with',
  promised_to: 'Promised to',
  related_to: 'Related to',
  part_of: 'Part of',
  owns: 'Owns',
};

/** All relation types, in the order they should appear in filters. */
export const RELATION_TYPES: RelationType[] = [
  'works_at',
  'located_in',
  'involved_in',
  'discussed_with',
  'promised_to',
  'related_to',
  'part_of',
  'owns',
];

/**
 * Concrete hex fills per entity type for the SVG graph canvas — HeroUI's chip
 * colours are semantic CSS tokens that an SVG `fill` can't resolve, so the
 * graph needs literal colours. Chosen mid-saturation so they read on both the
 * light and the dark canvas background.
 */
export const ENTITY_TYPE_HEX: Record<EntityType, string> = {
  person: '#3b82f6',
  organization: '#a855f7',
  place: '#22c55e',
  date: '#64748b',
  amount: '#f59e0b',
  product: '#8b5cf6',
  medication: '#ef4444',
  document_reference: '#0ea5e9',
};

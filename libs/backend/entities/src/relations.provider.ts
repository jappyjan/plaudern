import type { EntityType, ExtractedRelation } from '@plaudern/contracts';

/** One entity of the item, offered to the model as a legal relation endpoint. */
export interface RelationEntityRef {
  name: string;
  type: EntityType;
}

export interface RelationExtractionInput {
  /** The transcript (or text) to pull relations from. */
  text: string;
  /** The item's extracted entities — the only legal relation endpoints. */
  entities: RelationEntityRef[];
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred — helps the model resolve relative dates. */
  occurredAt?: string;
}

export interface RelationExtractionResult {
  relations: ExtractedRelation[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Relation-extraction backend. The default is the same OpenAI-compatible
 * chat-completions endpoint as entity extraction (ENTITY_EXTRACTION_*):
 * relations can only exist downstream of entities, so one knob configures the
 * whole knowledge-graph tier. Tests override the DI token with a fake.
 */
export interface RelationExtractionProvider {
  readonly id: string;
  extract(userId: string, input: RelationExtractionInput): Promise<RelationExtractionResult>;
}

export const RELATION_EXTRACTION_PROVIDER = Symbol('RELATION_EXTRACTION_PROVIDER');

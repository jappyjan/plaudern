import type { ExtractedEntity } from '@plaudern/contracts';

export interface EntityExtractionInput {
  /** The transcript (or text) to pull entities from. */
  text: string;
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred — helps the model resolve relative dates. */
  occurredAt?: string;
}

export interface EntityExtractionResult {
  entities: ExtractedEntity[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Entity-extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the summarization provider so the
 * same local-model tier keeps sensitive transcripts off the network. Tests
 * override the DI token with a fake.
 */
export interface EntityExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: EntityExtractionInput): Promise<EntityExtractionResult>;
}

export const ENTITY_EXTRACTION_PROVIDER = Symbol('ENTITY_EXTRACTION_PROVIDER');

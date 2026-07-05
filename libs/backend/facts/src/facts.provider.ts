import type { ExtractedFact } from '@plaudern/contracts';

/** A person known to the user, offered to the model as a linking hint. */
export interface FactKnownPerson {
  /** Display name of a registry `person` entity. */
  name: string;
}

export interface FactExtractionInput {
  /** The transcript (or summary) the personal facts are pulled from. */
  text: string;
  /**
   * Names of the user's known contacts, so the model prefers a known spelling
   * when naming a fact's subject (improves registry linkage). Advisory only.
   */
  knownPeople: FactKnownPerson[];
  /** Detected content language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred — context for the model. */
  occurredAt?: string;
}

export interface FactExtractionResult {
  facts: ExtractedFact[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Personal-fact extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the summarization/entities/topics/
 * tasks providers so the same local-model tier keeps sensitive transcripts off
 * the network. Tests override the DI token with a fake.
 */
export interface FactExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: FactExtractionInput): Promise<FactExtractionResult>;
}

export const FACT_EXTRACTION_PROVIDER = Symbol('FACT_EXTRACTION_PROVIDER');

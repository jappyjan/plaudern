import type { ExtractedDecision } from '@plaudern/contracts';

/** One speaker on the recording, so the model can attribute participants. */
export interface DecisionSpeaker {
  /** Per-recording diarization label, e.g. SPEAKER_00. */
  label: string;
  /** Resolved display name ("Anna", "Speaker 2"). */
  displayName: string;
}

export interface DecisionExtractionInput {
  /**
   * The speaker-attributed transcript (each block prefixed with its speaker
   * LABEL when diarization is available) the decisions are pulled from.
   */
  transcript: string;
  /** The diarized speaker roster, for attributing who was involved. */
  speakers: DecisionSpeaker[];
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred, for context. */
  occurredAt?: string;
}

export interface DecisionExtractionResult {
  decisions: ExtractedDecision[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Decision-extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the questions/commitments/topics
 * providers so the same local-model tier keeps sensitive transcripts off the
 * network. Tests override the DI token with a fake.
 */
export interface DecisionExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: DecisionExtractionInput): Promise<DecisionExtractionResult>;
}

export const DECISION_EXTRACTION_PROVIDER = Symbol('DECISION_EXTRACTION_PROVIDER');

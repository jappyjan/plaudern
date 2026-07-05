import type { ExtractedQuestion } from '@plaudern/contracts';

/** One speaker on the recording, so the model can attribute direction. */
export interface QuestionSpeaker {
  /** Per-recording diarization label, e.g. SPEAKER_00. */
  label: string;
  /** Resolved display name ("Anna", "Speaker 2"). */
  displayName: string;
}

export interface QuestionExtractionInput {
  /**
   * The speaker-attributed transcript (each block prefixed with its speaker
   * LABEL when diarization is available) the questions are pulled from.
   */
  transcript: string;
  /** The diarized speaker roster, for attributing who asked whom. */
  speakers: QuestionSpeaker[];
  /**
   * The label of the owner ("me") when known — questions from this speaker are
   * `asked_by_me`. Null when the owner's own voice was not identified, in which
   * case the model falls back to first-person ("did I ever…") language.
   */
  ownerLabel?: string | null;
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred, for context. */
  occurredAt?: string;
}

export interface QuestionExtractionResult {
  questions: ExtractedQuestion[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Question-extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the commitments/entities/topics
 * providers so the same local-model tier keeps sensitive transcripts off the
 * network. Tests override the DI token with a fake.
 */
export interface QuestionExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: QuestionExtractionInput): Promise<QuestionExtractionResult>;
}

export const QUESTION_EXTRACTION_PROVIDER = Symbol('QUESTION_EXTRACTION_PROVIDER');

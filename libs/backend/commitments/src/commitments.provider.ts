import type { ExtractedCommitment } from '@plaudern/contracts';

/** One speaker on the recording, so the model can attribute direction. */
export interface CommitmentSpeaker {
  /** Per-recording diarization label, e.g. SPEAKER_00. */
  label: string;
  /** Resolved display name ("Anna", "Speaker 2"). */
  displayName: string;
}

export interface CommitmentExtractionInput {
  /**
   * The speaker-attributed transcript (each block prefixed with its speaker
   * LABEL when diarization is available) the commitments are pulled from.
   */
  transcript: string;
  /** The diarized speaker roster, for attributing who owes whom. */
  speakers: CommitmentSpeaker[];
  /**
   * The label of the owner ("me") when known — statements from this speaker are
   * `owed_by_me`. Null when the owner's own voice was not identified, in which
   * case the model falls back to first-person ("I'll…") language.
   */
  ownerLabel?: string | null;
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred — the anchor for resolving relative dates. */
  occurredAt?: string;
}

export interface CommitmentExtractionResult {
  commitments: ExtractedCommitment[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Commitment-extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the entities/topics providers so the
 * same local-model tier keeps sensitive transcripts off the network. Tests
 * override the DI token with a fake.
 */
export interface CommitmentExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: CommitmentExtractionInput): Promise<CommitmentExtractionResult>;
}

export const COMMITMENT_EXTRACTION_PROVIDER = Symbol('COMMITMENT_EXTRACTION_PROVIDER');

import type { ExtractedTask } from '@plaudern/contracts';

/** One diarized speaker in the recording, so the model can tell them apart. */
export interface TaskSpeaker {
  /** Per-recording diarization label, e.g. SPEAKER_00. */
  label: string;
  /** Resolved display name ("Anna", "Speaker 2"). */
  displayName: string;
}

export interface TaskExtractionInput {
  /** The transcript (or summary) to pull the owner's intentions from. */
  text: string;
  /**
   * The owner's name ("me"), whenever a self profile exists. The model extracts
   * ONLY this person's tasks. Null when the owner is unnamed, in which case
   * first-person intentions are treated as the owner's.
   */
  ownerName?: string | null;
  /** The owner's diarization label in this recording, when they spoke. */
  ownerLabel?: string | null;
  /** The diarized speaker roster, so tasks can be attributed to the owner vs others. */
  speakers?: TaskSpeaker[];
  /** Detected content language (2-letter code), for context. */
  language?: string;
  /** When the recording occurred — helps the model resolve relative due dates. */
  occurredAt?: string;
}

export interface TaskExtractionResult {
  tasks: ExtractedTask[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Task-extraction backend. The default is an OpenAI-compatible chat-completions
 * provider (works with DeepSeek, OpenAI, OpenRouter, a local Ollama/llama.cpp
 * gateway, …), mirroring the summarization/entities/topics providers so the
 * same local-model tier keeps sensitive transcripts off the network. Tests
 * override the DI token with a fake.
 */
export interface TaskExtractionProvider {
  readonly id: string;
  extract(userId: string, input: TaskExtractionInput): Promise<TaskExtractionResult>;
}

export const TASK_EXTRACTION_PROVIDER = Symbol('TASK_EXTRACTION_PROVIDER');

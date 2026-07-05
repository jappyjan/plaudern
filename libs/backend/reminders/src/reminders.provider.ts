import type { ExtractedReminder } from '@plaudern/contracts';

export interface ReminderExtractionInput {
  /** The transcript (plain or speaker-attributed) the reminders are pulled from. */
  transcript: string;
  /** Detected transcript language (2-letter code), for context. */
  language?: string;
  /**
   * When the recording occurred (ISO). The model is told to resolve relative
   * dates against THIS, not "now", and the server re-resolves against it too.
   */
  occurredAt?: string;
}

export interface ReminderExtractionResult {
  reminders: ExtractedReminder[];
  /** Concrete model that produced the result, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Reminder-extraction backend. The default is an OpenAI-compatible
 * chat-completions provider (works with DeepSeek, OpenAI, OpenRouter, a local
 * Ollama/llama.cpp gateway, …), mirroring the decisions/questions providers so
 * the same local-model tier keeps sensitive transcripts off the network. Tests
 * override the DI token with a fake.
 */
export interface ReminderExtractionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: ReminderExtractionInput): Promise<ReminderExtractionResult>;
}

export const REMINDER_EXTRACTION_PROVIDER = Symbol('REMINDER_EXTRACTION_PROVIDER');

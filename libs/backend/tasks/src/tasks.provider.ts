import type { ExtractedTask } from '@plaudern/contracts';

export interface TaskExtractionInput {
  /** The transcript (or summary) to pull the user's intentions from. */
  text: string;
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
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  extract(input: TaskExtractionInput): Promise<TaskExtractionResult>;
}

export const TASK_EXTRACTION_PROVIDER = Symbol('TASK_EXTRACTION_PROVIDER');

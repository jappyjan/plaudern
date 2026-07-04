/** One candidate topic the classifier may assign, drawn from the user's taxonomy. */
export interface TopicCandidate {
  id: string;
  name: string;
  description?: string | null;
}

export interface TopicClassificationInput {
  /** The item's text to classify (its summary when available, else transcript). */
  content: string;
  /** The user's active (non-archived) taxonomy the item is tagged against. */
  topics: TopicCandidate[];
  /** Detected content language (2-letter code), for context. */
  language?: string;
}

/** One topic the model chose to assign, referencing a candidate id. */
export interface TopicClassificationAssignment {
  topicId: string;
  /** Model confidence in [0, 1]. */
  confidence: number;
}

export interface TopicClassificationResult {
  assignments: TopicClassificationAssignment[];
  /** Concrete model that produced the classification, for provenance. */
  model?: string;
  raw?: unknown;
}

/**
 * Topic-classification backend. The default is an OpenAI-compatible
 * chat-completions provider (DeepSeek, OpenAI, OpenRouter, a local Ollama /
 * llama.cpp gateway, …), mirroring summarization. Tests override the DI token
 * with a fake.
 */
export interface TopicClassificationProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  classify(input: TopicClassificationInput): Promise<TopicClassificationResult>;
}

export const TOPIC_CLASSIFICATION_PROVIDER = Symbol('TOPIC_CLASSIFICATION_PROVIDER');

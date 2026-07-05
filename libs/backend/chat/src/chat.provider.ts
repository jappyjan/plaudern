/** One turn passed to the chat-completions endpoint. */
export interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  /** Raw text of the model reply (the service parses/enforces it). */
  content: string;
  /** Concrete model that produced the reply, for provenance. */
  model: string;
}

/**
 * Memory-chat LLM backend (JJ-37). The default is an OpenAI-compatible
 * chat-completions provider (DeepSeek, OpenAI, OpenRouter, a local Ollama /
 * llama.cpp gateway, …), mirroring summarization/topics/tasks. Tests override
 * the DI token with a fake.
 */
export interface ChatCompletionProvider {
  readonly id: string;
  /** Whether the provider is configured enough to run (e.g. has an API key). */
  readonly enabled: boolean;
  complete(messages: ChatCompletionMessage[]): Promise<ChatCompletionResult>;
}

export const CHAT_COMPLETION_PROVIDER = Symbol('CHAT_COMPLETION_PROVIDER');

import { Injectable } from '@nestjs/common';
import type { ResolvedAiConfig } from './resolved-config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: unknown;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  response_format?: { type: string };
  /** Any extra OpenAI-compatible fields (e.g. max_tokens). */
  [key: string]: unknown;
}

export interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  model?: string;
  [key: string]: unknown;
}

/**
 * Thin shared client for OpenAI-compatible `/chat/completions` endpoints. Takes
 * a `ResolvedAiConfig` (per-user, from `AiConfigService`) instead of reading
 * env, so every chat/vision capability collapses to: resolve → build messages →
 * `chat(config, …)` → parse. Local keyless servers (Ollama, llama.cpp) simply
 * have `apiKey === null` and get no Authorization header.
 */
@Injectable()
export class OpenAiChatClient {
  async chat(config: ResolvedAiConfig, request: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: config.model, ...request }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`chat request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      return (await res.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience: the text content of the first choice. */
  contentOf(response: ChatResponse): string {
    return response.choices?.[0]?.message?.content ?? '';
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import type {
  ChatCompletionMessage,
  ChatCompletionProvider,
  ChatCompletionResult,
} from '../chat.provider';

interface ChatChoice {
  message?: { content?: string | null };
}
interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
}

/**
 * Memory chat via an OpenAI-compatible `/chat/completions` endpoint. Defaults
 * to DeepSeek (`deepseek-chat`) like the other extractors; any provider
 * exposing the OpenAI schema works by overriding CHAT_BASE_URL/MODEL,
 * including a **local Ollama** server (`CHAT_BASE_URL=http://localhost:11434/v1`).
 * Only retrieved text passages are sent, never audio.
 *
 * The CHAT_* env vars fall back to the SUMMARIZATION_* tier (same key, same
 * endpoint) so a deploy that already summarizes gets chat for free — exactly
 * how entities/topics/tasks reuse the summarization key in the Coolify
 * compose. With neither key set the feature ships DISABLED.
 */
@Injectable()
export class OpenAiChatCompletionProvider implements ChatCompletionProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(
    config: ConfigService,
    private readonly audit: AiAuditRecorder,
  ) {
    const fallbackBaseUrl = config.get<string>(
      'SUMMARIZATION_BASE_URL',
      'https://api.deepseek.com/v1',
    );
    this.baseUrl = config.get<string>('CHAT_BASE_URL', fallbackBaseUrl).replace(/\/+$/, '');
    this.apiKey =
      config.get<string>('CHAT_API_KEY', '') || config.get<string>('SUMMARIZATION_API_KEY', '');
    this.model = config.get<string>('CHAT_MODEL', 'deepseek-chat');
    this.timeoutMs = Number(config.get<string>('CHAT_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled".
    // Keyless local OpenAI-compatible servers (Ollama, llama.cpp, ...) opt in
    // explicitly instead of configuring a throwaway key.
    this.explicitlyEnabled = config.get<string>('CHAT_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async complete(messages: ChatCompletionMessage[]): Promise<ChatCompletionResult> {
    if (!this.enabled) {
      throw new Error(
        'memory chat is disabled — set CHAT_API_KEY (or SUMMARIZATION_API_KEY, which it ' +
          'falls back to) for cloud endpoints, or CHAT_ENABLED=true for keyless local ' +
          'endpoints such as Ollama',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Most local servers (Ollama, llama.cpp) ignore auth entirely; only send
      // the header when a key was actually configured.
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const endpoint = `${this.baseUrl}/chat/completions`;
      const body = JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages,
      });
      // Audit the exact bytes leaving the box before they leave (JJ-42).
      await this.audit.record({ provider: this.id, endpoint, payload: body });
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`chat completion request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as ChatResponse;
      const content = json.choices?.[0]?.message?.content ?? '';
      return { content, model: json.model ?? this.model };
    } finally {
      clearTimeout(timer);
    }
  }
}

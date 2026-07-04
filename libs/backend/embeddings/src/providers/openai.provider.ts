import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '../embedding.provider';

interface EmbeddingsResponseItem {
  embedding?: number[];
  index?: number;
}
interface EmbeddingsResponse {
  data?: EmbeddingsResponseItem[];
  model?: string;
}

/**
 * Embeds text via an OpenAI-compatible `/embeddings` endpoint. Defaults to
 * OpenAI's `text-embedding-3-small` (1536 dims) but any provider exposing the
 * OpenAI schema works by overriding EMBEDDINGS_BASE_URL/MODEL — including a
 * **local Ollama** server (`EMBEDDINGS_ENABLED=true`,
 * `EMBEDDINGS_BASE_URL=http://localhost:11434/v1`,
 * `EMBEDDINGS_MODEL=nomic-embed-text`, `EMBEDDINGS_DIMENSIONS=768`), the same
 * keyless local-model tier the summarizer supports (see ATT-662/ATT-687).
 * Note: DeepSeek exposes NO embeddings endpoint (chat models only), so the
 * DeepSeek summarization key cannot be reused here — keyless Ollama is the
 * fewest-keys option.
 *
 * Only text is sent — never audio — to the operator-chosen endpoint.
 */
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  private readonly logger = new Logger(OpenAiEmbeddingProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly explicitlyEnabled: boolean;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('EMBEDDINGS_BASE_URL', 'https://api.openai.com/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('EMBEDDINGS_API_KEY', '');
    this.model = config.get<string>('EMBEDDINGS_MODEL', 'text-embedding-3-small');
    this.dimensions = Number(
      config.get<string>('EMBEDDINGS_DIMENSIONS', String(DEFAULT_EMBEDDING_DIMENSIONS)),
    );
    this.timeoutMs = Number(config.get<string>('EMBEDDINGS_TIMEOUT_MS', String(2 * 60_000)));
    // Cloud endpoints are gated on an API key — an empty key means "disabled"
    // (documented in .env.example). Keyless local OpenAI-compatible servers
    // (Ollama, text-embeddings-inference, ...) have no key to set, so they opt
    // in explicitly instead of being forced to configure a throwaway one.
    // Mirrors SUMMARIZATION_ENABLED (ATT-662).
    this.explicitlyEnabled = config.get<string>('EMBEDDINGS_ENABLED', 'false') === 'true';
    this.id = `openai:${this.model}`;
  }

  get enabled(): boolean {
    return this.apiKey.length > 0 || this.explicitlyEnabled;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!this.enabled) {
      throw new Error(
        'embeddings are disabled — set EMBEDDINGS_API_KEY (cloud endpoints) or ' +
          'EMBEDDINGS_ENABLED=true (keyless local endpoints such as Ollama) to enable them',
      );
    }
    if (texts.length === 0) {
      return { vectors: [], model: this.model, dimensions: this.dimensions };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      // Most local servers (Ollama, text-embeddings-inference) ignore auth
      // entirely; only send the header when a key was actually configured.
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          input: texts,
          // Providers that support dimension reduction (OpenAI v3 models) honor
          // this; others ignore it and return their native dimension.
          dimensions: this.dimensions,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`embeddings request failed: ${res.status} ${body.slice(0, 500)}`);
      }
      const json = (await res.json()) as EmbeddingsResponse;
      const rows = (json.data ?? [])
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = rows.map((row) => row.embedding ?? []);
      if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
        throw new Error(
          `embeddings response shape mismatch: expected ${texts.length} vectors, got ${vectors.length}`,
        );
      }
      const dimensions = vectors[0].length;
      if (dimensions !== this.dimensions) {
        this.logger.warn(
          `provider returned ${dimensions}-dim vectors but EMBEDDINGS_DIMENSIONS=${this.dimensions}; using ${dimensions}`,
        );
      }
      return { vectors, model: json.model ?? this.model, dimensions };
    } finally {
      clearTimeout(timer);
    }
  }
}

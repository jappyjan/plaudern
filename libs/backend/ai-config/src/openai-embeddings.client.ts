import { Injectable } from '@nestjs/common';
import { numberParam, type ResolvedAiConfig } from './resolved-config';

export interface EmbeddingsResponse {
  data?: { embedding?: number[] }[];
  model?: string;
}

/**
 * Thin shared client for OpenAI-compatible `/embeddings` endpoints. Takes a
 * per-user `ResolvedAiConfig`; sends the `dimensions` param when the capability
 * config carries one (matches the old EMBEDDINGS_DIMENSIONS behavior).
 */
@Injectable()
export class OpenAiEmbeddingsClient {
  async embed(config: ResolvedAiConfig, input: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const dimensions = numberParam(config, 'dimensions', 0);
      const body: Record<string, unknown> = { model: config.model, input };
      if (dimensions > 0) body.dimensions = dimensions;
      const res = await fetch(`${config.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`embeddings request failed: ${res.status} ${text.slice(0, 500)}`);
      }
      const json = (await res.json()) as EmbeddingsResponse;
      return (json.data ?? []).map((d) => d.embedding ?? []);
    } finally {
      clearTimeout(timer);
    }
  }
}

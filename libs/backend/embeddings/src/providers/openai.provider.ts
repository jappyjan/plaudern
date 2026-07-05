import { Injectable, Logger } from '@nestjs/common';
import { AiConfigService, OpenAiEmbeddingsClient, numberParam } from '@plaudern/ai-config';
import {
  DEFAULT_EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from '../embedding.provider';

/**
 * Embeds text via an OpenAI-compatible `/embeddings` endpoint, using the
 * per-user AI config resolved for the `embeddings` capability (Settings → AI).
 * Works with OpenAI, a keyless local Ollama/text-embeddings-inference gateway,
 * etc. — whatever provider the user assigned to the capability.
 *
 * Only text is sent — never audio — to the operator-chosen endpoint.
 */
@Injectable()
export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  private readonly logger = new Logger(OpenAiEmbeddingProvider.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly client: OpenAiEmbeddingsClient,
  ) {}

  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'embeddings');
  }

  async embed(userId: string, texts: string[]): Promise<EmbeddingResult> {
    const config = await this.aiConfig.resolve(userId, 'embeddings');
    if (!config) {
      throw new Error(
        'embeddings are not configured — assign a provider to the embeddings capability in Settings → AI',
      );
    }
    const dimensions = numberParam(config, 'dimensions', DEFAULT_EMBEDDING_DIMENSIONS);
    if (texts.length === 0) {
      return { vectors: [], model: config.model, dimensions };
    }
    const vectors = await this.client.embed(config, texts);
    if (vectors.length !== texts.length || vectors.some((v) => v.length === 0)) {
      throw new Error(
        `embeddings response shape mismatch: expected ${texts.length} vectors, got ${vectors.length}`,
      );
    }
    const returnedDimensions = vectors[0].length;
    if (returnedDimensions !== dimensions) {
      this.logger.warn(
        `provider returned ${returnedDimensions}-dim vectors but config dimensions=${dimensions}`,
      );
    }
    return { vectors, model: config.model, dimensions };
  }
}

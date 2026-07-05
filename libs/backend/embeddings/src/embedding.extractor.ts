import { Injectable } from '@nestjs/common';
import { AiConfigService } from '@plaudern/ai-config';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { EmbeddingService, EMBEDDING_EXTRACTOR_VERSION } from './embedding.service';

/**
 * Chunked vector embeddings as a node of the extraction DAG. Depends on
 * transcription (required — nothing to embed without a transcript) and summary
 * (settled — wait for it when it applies so its prose is embedded alongside
 * the transcript, but a missing or failed summary must not block embedding:
 * the transcript is embedded regardless). The generic pipeline evaluates these
 * edges exactly like the old bespoke EmbeddingTrigger did.
 */
@Injectable()
export class EmbeddingExtractor implements Extractor {
  readonly kind = 'embedding' as const;
  readonly version = EMBEDDING_EXTRACTOR_VERSION;
  readonly dependsOn: ExtractorDependency[] = [
    { kind: 'transcription', requires: 'succeeded' },
    { kind: 'summary', requires: 'settled' },
  ];

  constructor(
    private readonly embeddings: EmbeddingService,
    private readonly aiConfig: AiConfigService,
  ) {}

  enabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'embeddings');
  }

  appliesTo(item: InboxItemEntity): boolean {
    // Any committed source qualifies; the required transcription dependency
    // does the real gating (today only audio-bearing items get transcripts).
    return item.source?.uploadStatus === 'committed';
  }

  async enqueue(item: InboxItemEntity): Promise<string | null> {
    return this.embeddings.enqueueEmbedding(item.id);
  }
}

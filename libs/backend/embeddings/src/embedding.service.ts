import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { InboxService } from '@plaudern/inbox';
import type { ExtractionStatus } from '@plaudern/contracts';
import type { ExtractedPayloadEntity } from '@plaudern/persistence';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import { EMBEDDING_QUEUE, type EmbeddingQueue } from './embedding.job';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

/**
 * Version of the embedding extractor (kind@version), recorded on every
 * appended row. Bump when the output meaningfully improves (better model,
 * better chunking) so backfill runs can catch older items up.
 */
export const EMBEDDING_EXTRACTOR_VERSION = 1;

/**
 * Owns the embedding pipeline step. WHEN embeddings run is decided by the
 * extraction DAG (`EmbeddingExtractor` + the generic pipeline in
 * `@plaudern/extraction` — transcription must succeed, and the summary, when
 * it applies, must settle first so its prose is embedded alongside the
 * transcript). This service owns HOW: enqueueing and the manual retry.
 */
@Injectable()
export class EmbeddingService {
  constructor(
    private readonly inbox: InboxService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly provider: EmbeddingProvider,
    @Inject(EMBEDDING_QUEUE)
    private readonly queue: EmbeddingQueue,
  ) {}

  /**
   * Whether embeddings are configured (EMBEDDINGS_API_KEY present, or
   * EMBEDDINGS_ENABLED=true for keyless local endpoints such as Ollama).
   */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  /**
   * Manually (re)generate embeddings for an item — e.g. after a failure or a
   * provider/model change. Appends a fresh extraction + chunks; older ones stay
   * in history (append-only).
   */
  async retry(userId: string, inboxItemId: string): Promise<string> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'embeddings are not configured (set EMBEDDINGS_API_KEY, or EMBEDDINGS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const item = await this.inbox.getItem(userId, inboxItemId);
    const extractions = item.extractions ?? [];
    const transcription = latestOfKind(extractions, 'transcription');
    if (transcription?.status !== 'succeeded') {
      throw new BadRequestException('item has no completed transcription to embed');
    }
    const embedding = latestOfKind(extractions, 'embedding');
    if (embedding && ACTIVE_STATUSES.includes(embedding.status)) {
      throw new ConflictException('embeddings are already being generated');
    }
    return this.enqueueEmbedding(inboxItemId);
  }

  /** Append a fresh `queued` embedding row and hand the job to the queue. */
  async enqueueEmbedding(inboxItemId: string): Promise<string> {
    const extraction = await this.inbox.addExtraction(
      inboxItemId,
      'embedding',
      this.provider.id,
      EMBEDDING_EXTRACTOR_VERSION,
    );
    await this.queue.enqueue({ extractionId: extraction.id, inboxItemId });
    return extraction.id;
  }
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

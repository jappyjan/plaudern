import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { runWithAiAudit } from '@plaudern/audit';
import { InboxService } from '@plaudern/inbox';
import type { EmbeddingPayload } from '@plaudern/contracts';
import { EmbeddingChunkEntity } from '@plaudern/persistence';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from './embedding.provider';
import { buildEmbeddableChunks } from './embedding-context';
import type { EmbeddingJob } from './embedding.job';

/**
 * Executes one embedding job: rebuild the embeddable chunks (timestamped
 * transcript windows + summary prose) from the item's latest extractions, embed
 * them via the provider, and persist one `embedding_chunks` row per chunk
 * (vectors land in pgvector on Postgres). The parent `embedding` extraction row
 * records provenance in `content`. Shared by the inline and BullMQ queues.
 */
@Injectable()
export class EmbeddingProcessor {
  private readonly logger = new Logger(EmbeddingProcessor.name);

  constructor(
    private readonly inbox: InboxService,
    @Inject(EMBEDDING_PROVIDER)
    private readonly provider: EmbeddingProvider,
    @InjectRepository(EmbeddingChunkEntity)
    private readonly chunks: Repository<EmbeddingChunkEntity>,
  ) {}

  async process(job: EmbeddingJob): Promise<void> {
    await this.inbox.setExtractionStatus(job.extractionId, 'processing');
    try {
      const item = await this.inbox.getItemById(job.inboxItemId);
      if (!item) throw new Error('inbox item no longer exists');

      const { chunks, transcriptChunks, summaryChunks } = buildEmbeddableChunks(item);
      if (chunks.length === 0) {
        throw new Error('nothing to embed (no succeeded transcription content)');
      }

      // Attribute the external embeddings call to this user/item so the
      // provider adapter can audit the bytes it sends (JJ-42).
      const { vectors, model, dimensions } = await runWithAiAudit(
        { userId: item.userId, itemId: item.id, kind: 'embedding' },
        () => this.provider.embed(chunks.map((c) => c.text)),
      );

      const rows = chunks.map((chunk, i) =>
        this.chunks.create({
          extractionId: job.extractionId,
          inboxItemId: item.id,
          userId: item.userId,
          source: chunk.source,
          chunkIndex: chunk.chunkIndex,
          text: chunk.text,
          startSeconds: chunk.startSeconds,
          endSeconds: chunk.endSeconds,
          model,
          dimensions,
          embedding: vectors[i],
        }),
      );
      await this.chunks.save(rows);

      const payload: EmbeddingPayload = {
        model,
        dimensions,
        chunkCount: chunks.length,
        transcriptChunks,
        summaryChunks,
      };
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'succeeded',
        content: JSON.stringify(payload),
      });
      this.logger.log(
        `embedded inbox item ${job.inboxItemId} (${chunks.length} chunks, ${dimensions}d, ${model})`,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`embedding failed for ${job.inboxItemId}: ${message}`);
      await this.inbox.completeExtraction(job.extractionId, {
        status: 'failed',
        error: message,
      });
      throw err;
    }
  }
}

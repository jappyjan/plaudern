import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { EmbeddingChunkEntity } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { EMBEDDING_PROVIDER } from './embedding.provider';
import { EMBEDDING_QUEUE } from './embedding.job';
import { OpenAiEmbeddingProvider } from './providers/openai.provider';
import { EmbeddingProcessor } from './embedding.processor';
import { EmbeddingService } from './embedding.service';
import { EmbeddingSearchService } from './embedding.search';
import { EmbeddingExtractor } from './embedding.extractor';

@Module({
  imports: [ConfigModule, InboxModule, TypeOrmModule.forFeature([EmbeddingChunkEntity])],
  providers: [
    OpenAiEmbeddingProvider,
    // Only one provider for now (any OpenAI-compatible /embeddings endpoint);
    // the token keeps the seam for future providers and test fakes.
    {
      provide: EMBEDDING_PROVIDER,
      inject: [OpenAiEmbeddingProvider],
      useFactory: (openai: OpenAiEmbeddingProvider) => openai,
    },
    EmbeddingProcessor,
    {
      provide: EMBEDDING_QUEUE,
      inject: [ConfigService, EmbeddingProcessor],
      useFactory: (config: ConfigService, processor: EmbeddingProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('embedding', 'embed', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    EmbeddingService,
    EmbeddingSearchService,
    EmbeddingExtractor,
  ],
  exports: [EmbeddingService, EmbeddingSearchService, EmbeddingExtractor],
})
export class EmbeddingModule {}

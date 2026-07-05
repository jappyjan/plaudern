import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiConfigService, OpenAiEmbeddingsClient } from '@plaudern/ai-config';
import { InboxModule } from '@plaudern/inbox';
import { OpenAiEmbeddingProvider } from '@plaudern/embeddings';
import {
  ExtractedPayloadEntity,
  SpeakerOccurrenceEntity,
  TaskCitationEntity,
  TaskEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TASK_EXTRACTION_PROVIDER } from './tasks.provider';
import { TASK_EXTRACTION_QUEUE } from './tasks.job';
import { OpenAiTaskExtractionProvider } from './providers/openai.provider';
import {
  TASK_DEDUPE_EMBEDDING_PROVIDER,
  TasksRegistryService,
} from './tasks-registry.service';
import { TasksProcessor } from './tasks.processor';
import { TasksService } from './tasks.service';
import { TasksExtractor } from './tasks.extractor';
import { TaskContextService } from './task-context';
import { InboxTasksController, TasksController } from './tasks.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      TaskEntity,
      TaskCitationEntity,
      ExtractedPayloadEntity,
      SpeakerOccurrenceEntity,
    ]),
  ],
  providers: [
    OpenAiTaskExtractionProvider,
    // The task-extraction LLM (any OpenAI-compatible /chat/completions endpoint,
    // DeepSeek by default) and the dedupe embeddings provider (any
    // OpenAI-compatible /embeddings endpoint, reads EMBEDDINGS_*). The tokens
    // keep the seam for future providers and test fakes.
    {
      provide: TASK_EXTRACTION_PROVIDER,
      inject: [OpenAiTaskExtractionProvider],
      useFactory: (openai: OpenAiTaskExtractionProvider) => openai,
    },
    {
      provide: TASK_DEDUPE_EMBEDDING_PROVIDER,
      inject: [AiConfigService, OpenAiEmbeddingsClient],
      useFactory: (aiConfig: AiConfigService, client: OpenAiEmbeddingsClient) =>
        new OpenAiEmbeddingProvider(aiConfig, client),
    },
    TasksRegistryService,
    TaskContextService,
    TasksProcessor,
    {
      provide: TASK_EXTRACTION_QUEUE,
      inject: [ConfigService, TasksProcessor],
      useFactory: (config: ConfigService, processor: TasksProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('tasks', 'extract-tasks', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    TasksService,
    TasksExtractor,
  ],
  controllers: [TasksController, InboxTasksController],
  // TasksRegistryService is exported so the open-loop ledger (JJ-29) can reuse
  // the authoritative task read model + status mutation without duplicating its
  // dedupe/ghost-hiding accounting.
  exports: [TasksService, TasksExtractor, TasksRegistryService],
})
export class TasksModule {}

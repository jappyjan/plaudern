import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import { OpenAiEmbeddingProvider } from '@plaudern/embeddings';
import {
  ExtractedPayloadEntity,
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
import { InboxTasksController, TasksController } from './tasks.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([TaskEntity, TaskCitationEntity, ExtractedPayloadEntity]),
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
    OpenAiEmbeddingProvider,
    {
      provide: TASK_DEDUPE_EMBEDDING_PROVIDER,
      inject: [OpenAiEmbeddingProvider],
      useFactory: (openai: OpenAiEmbeddingProvider) => openai,
    },
    TasksRegistryService,
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
  exports: [TasksService, TasksExtractor],
})
export class TasksModule {}

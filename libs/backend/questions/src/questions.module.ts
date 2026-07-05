import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InboxModule } from '@plaudern/inbox';
import {
  EntityRegistryEntity,
  InboxItemEntity,
  QuestionEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { QUESTION_EXTRACTION_PROVIDER } from './questions.provider';
import { QUESTIONS_QUEUE } from './questions.job';
import { OpenAiQuestionExtractionProvider } from './providers/openai.provider';
import { QuestionContextService } from './question-context';
import { QuestionsPersistenceService } from './questions-persistence.service';
import { QuestionsProcessor } from './questions.processor';
import { QuestionsService } from './questions.service';
import { QuestionsExtractor } from './questions.extractor';
import { QuestionsController } from './questions.controller';
import { InboxQuestionsController } from './inbox-questions.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TypeOrmModule.forFeature([
      QuestionEntity,
      EntityRegistryEntity,
      InboxItemEntity,
      SpeakerOccurrenceEntity,
    ]),
  ],
  providers: [
    OpenAiQuestionExtractionProvider,
    // Only one provider for now (any OpenAI-compatible /chat/completions
    // endpoint); the token keeps the seam for future providers and test fakes.
    {
      provide: QUESTION_EXTRACTION_PROVIDER,
      inject: [OpenAiQuestionExtractionProvider],
      useFactory: (openai: OpenAiQuestionExtractionProvider) => openai,
    },
    QuestionContextService,
    // Persistence is a separate provider so the processor never needs an edge
    // back to QuestionsService (service → queue → processor → service would
    // deadlock Nest's module compile).
    QuestionsPersistenceService,
    QuestionsProcessor,
    {
      provide: QUESTIONS_QUEUE,
      inject: [ConfigService, QuestionsProcessor],
      useFactory: (config: ConfigService, processor: QuestionsProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'questions',
              'extract',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 2, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    QuestionsService,
    QuestionsExtractor,
  ],
  controllers: [QuestionsController, InboxQuestionsController],
  exports: [QuestionsService, QuestionsExtractor],
})
export class QuestionsModule {}

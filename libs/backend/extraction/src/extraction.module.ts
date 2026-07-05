import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExtractionRunEntity, InboxItemEntity } from '@plaudern/persistence';
import { EXTRACTORS, InboxModule, type Extractor } from '@plaudern/inbox';
import { TranscriptionExtractor, TranscriptionModule } from '@plaudern/transcription';
import { DiarizationExtractor, SpeakerIdModule } from '@plaudern/speaker-id';
import { SummaryExtractor, SummarizationModule } from '@plaudern/summarization';
import { EmbeddingExtractor, EmbeddingModule } from '@plaudern/embeddings';
import { EntitiesExtractor, EntitiesModule, RelationsExtractor } from '@plaudern/entities';
import { TopicsExtractor, TopicsModule } from '@plaudern/topics';
import { CommitmentsExtractor, CommitmentsModule } from '@plaudern/commitments';
import { QuestionsExtractor, QuestionsModule } from '@plaudern/questions';
import { TasksExtractor, TasksModule } from '@plaudern/tasks';
import { FactsExtractor, FactsModule } from '@plaudern/facts';
import { DecisionsExtractor, DecisionsModule } from '@plaudern/decisions';
import { RemindersExtractor, RemindersModule } from '@plaudern/reminders';
import { SentinelExtractor, SentinelModule } from '@plaudern/sensitivity';
import { ExtractorGraph } from './extractor-graph';
import { ExtractionPipelineService } from './extraction-pipeline.service';
import { ExtractionRunsService } from './extraction-runs.service';
import { StartupBackfillService } from './startup-backfill.service';
import { OwnerReprocessService } from './owner-reprocess.service';
import { ExtractionController } from './extraction.controller';

/**
 * Aggregates every extraction kind into the declarative DAG (VISION §8).
 * Registering a new kind = implement `Extractor` in its own module, export
 * the class, and add it to the EXTRACTORS factory below — the pipeline,
 * versioning, and backfill machinery come for free.
 */
@Module({
  imports: [
    InboxModule,
    TranscriptionModule,
    SpeakerIdModule,
    SummarizationModule,
    EmbeddingModule,
    EntitiesModule,
    TopicsModule,
    CommitmentsModule,
    QuestionsModule,
    TasksModule,
    FactsModule,
    DecisionsModule,
    RemindersModule,
    SentinelModule,
    TypeOrmModule.forFeature([ExtractionRunEntity, InboxItemEntity]),
  ],
  providers: [
    {
      provide: EXTRACTORS,
      inject: [
        TranscriptionExtractor,
        DiarizationExtractor,
        SummaryExtractor,
        EmbeddingExtractor,
        EntitiesExtractor,
        TopicsExtractor,
        TasksExtractor,
        RelationsExtractor,
        CommitmentsExtractor,
        QuestionsExtractor,
        FactsExtractor,
        DecisionsExtractor,
        RemindersExtractor,
        SentinelExtractor,
      ],
      useFactory: (
        transcription: TranscriptionExtractor,
        diarization: DiarizationExtractor,
        summary: SummaryExtractor,
        embedding: EmbeddingExtractor,
        entities: EntitiesExtractor,
        topics: TopicsExtractor,
        tasks: TasksExtractor,
        relations: RelationsExtractor,
        commitments: CommitmentsExtractor,
        questions: QuestionsExtractor,
        facts: FactsExtractor,
        decisions: DecisionsExtractor,
        reminders: RemindersExtractor,
        sentinel: SentinelExtractor,
      ): Extractor[] => [
        transcription,
        diarization,
        summary,
        embedding,
        entities,
        topics,
        tasks,
        relations,
        commitments,
        questions,
        facts,
        decisions,
        reminders,
        sentinel,
      ],
    },
    {
      // Built once at boot; construction validates the declared graph
      // (duplicate kinds, unknown dependencies, cycles) and fails fast.
      provide: ExtractorGraph,
      inject: [EXTRACTORS],
      useFactory: (extractors: Extractor[]) => new ExtractorGraph(extractors),
    },
    ExtractionPipelineService,
    ExtractionRunsService,
    StartupBackfillService,
    OwnerReprocessService,
  ],
  controllers: [ExtractionController],
  exports: [ExtractionPipelineService, ExtractorGraph],
})
export class ExtractionModule {}

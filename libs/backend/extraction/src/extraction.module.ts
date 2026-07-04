import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExtractionRunEntity, InboxItemEntity } from '@plaudern/persistence';
import { EXTRACTORS, InboxModule, type Extractor } from '@plaudern/inbox';
import { TranscriptionExtractor, TranscriptionModule } from '@plaudern/transcription';
import { DiarizationExtractor, SpeakerIdModule } from '@plaudern/speaker-id';
import { SummaryExtractor, SummarizationModule } from '@plaudern/summarization';
import { EmbeddingExtractor, EmbeddingModule } from '@plaudern/embeddings';
import { ExtractorGraph } from './extractor-graph';
import { ExtractionPipelineService } from './extraction-pipeline.service';
import { ExtractionRunsService } from './extraction-runs.service';
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
    TypeOrmModule.forFeature([ExtractionRunEntity, InboxItemEntity]),
  ],
  providers: [
    {
      provide: EXTRACTORS,
      inject: [TranscriptionExtractor, DiarizationExtractor, SummaryExtractor, EmbeddingExtractor],
      useFactory: (
        transcription: TranscriptionExtractor,
        diarization: DiarizationExtractor,
        summary: SummaryExtractor,
        embedding: EmbeddingExtractor,
      ): Extractor[] => [transcription, diarization, summary, embedding],
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
  ],
  controllers: [ExtractionController],
  exports: [ExtractionPipelineService, ExtractorGraph],
})
export class ExtractionModule {}

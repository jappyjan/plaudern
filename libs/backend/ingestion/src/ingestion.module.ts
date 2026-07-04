import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecordingMergeEntity, SpeakerOccurrenceEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TranscriptionModule } from '@plaudern/transcription';
import { SpeakerIdModule } from '@plaudern/speaker-id';
import { ExtractionModule } from '@plaudern/extraction';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { SOURCE_ADAPTERS } from './source-adapter';
import { GenericAudioAdapter } from './adapters/generic-audio.adapter';
import { PlaudAdapter } from './adapters/plaud.adapter';
import { TextAdapter } from './adapters/text.adapter';
import { FileAdapter } from './adapters/file.adapter';
import { WebAdapter } from './adapters/web.adapter';
import { WEB_SNAPSHOT_FETCH, WebPageSnapshotService } from './web/web-page-snapshot.service';
import { EmailAdapter } from './adapters/email.adapter';
import { AUDIO_CONCATENATOR, FfmpegAudioConcatenator } from './merge/audio-concatenator';
import { RECORDING_MERGE_QUEUE } from './merge/recording-merge.job';
import { RecordingMergeProcessor } from './merge/recording-merge.processor';
import { RecordingMergeService } from './merge/recording-merge.service';
import { RecordingMergeController } from './merge/recording-merge.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    // Adapters run the extraction DAG on commit; the merge service still
    // reaches into the per-kind services for its stitching fast-path.
    ExtractionModule,
    TranscriptionModule,
    SpeakerIdModule,
    TypeOrmModule.forFeature([RecordingMergeEntity, SpeakerOccurrenceEntity]),
  ],
  providers: [
    GenericAudioAdapter,
    PlaudAdapter,
    TextAdapter,
    FileAdapter,
    WebAdapter,
    EmailAdapter,
    {
      provide: SOURCE_ADAPTERS,
      inject: [GenericAudioAdapter, PlaudAdapter, TextAdapter, FileAdapter, WebAdapter, EmailAdapter],
      useFactory: (
        audio: GenericAudioAdapter,
        plaud: PlaudAdapter,
        text: TextAdapter,
        file: FileAdapter,
        web: WebAdapter,
        email: EmailAdapter,
      ) => [audio, plaud, text, file, web, email],
    },
    // Plain global fetch behind a DI token so tests can fake the network.
    { provide: WEB_SNAPSHOT_FETCH, useValue: globalThis.fetch },
    WebPageSnapshotService,
    IngestionService,
    { provide: AUDIO_CONCATENATOR, useClass: FfmpegAudioConcatenator },
    RecordingMergeProcessor,
    {
      // The audio concatenation is a CPU-bound re-encode; run one at a time off
      // the request thread. Inline in tests/local dev (no Redis).
      provide: RECORDING_MERGE_QUEUE,
      inject: [ConfigService, RecordingMergeProcessor],
      useFactory: (config: ConfigService, processor: RecordingMergeProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue(
              'recording-merge',
              'merge',
              redisConnectionFromConfig(config),
              processor,
              { concurrency: 1, backoffDelayMs: 2_000 },
            )
          : new InlineJobQueue(processor),
    },
    RecordingMergeService,
  ],
  controllers: [IngestionController, RecordingMergeController],
  exports: [IngestionService, RecordingMergeService],
})
export class IngestionModule {}

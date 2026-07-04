import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecordingMergeEntity, SpeakerOccurrenceEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TranscriptionModule } from '@plaudern/transcription';
import { SpeakerIdModule } from '@plaudern/speaker-id';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { SOURCE_ADAPTERS } from './source-adapter';
import { GenericAudioAdapter } from './adapters/generic-audio.adapter';
import { PlaudAdapter } from './adapters/plaud.adapter';
import { TextAdapter } from './adapters/text.adapter';
import { FileAdapter } from './adapters/file.adapter';
import { AUDIO_CONCATENATOR, FfmpegAudioConcatenator } from './merge/audio-concatenator';
import { RECORDING_MERGE_QUEUE } from './merge/recording-merge.job';
import { RecordingMergeProcessor } from './merge/recording-merge.processor';
import { RecordingMergeService } from './merge/recording-merge.service';
import { RecordingMergeController } from './merge/recording-merge.controller';

@Module({
  imports: [
    ConfigModule,
    InboxModule,
    TranscriptionModule,
    SpeakerIdModule,
    TypeOrmModule.forFeature([RecordingMergeEntity, SpeakerOccurrenceEntity]),
  ],
  providers: [
    GenericAudioAdapter,
    PlaudAdapter,
    TextAdapter,
    FileAdapter,
    {
      provide: SOURCE_ADAPTERS,
      inject: [GenericAudioAdapter, PlaudAdapter, TextAdapter, FileAdapter],
      useFactory: (
        audio: GenericAudioAdapter,
        plaud: PlaudAdapter,
        text: TextAdapter,
        file: FileAdapter,
      ) => [audio, plaud, text, file],
    },
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

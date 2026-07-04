import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecordingMergeEntity, SpeakerOccurrenceEntity } from '@plaudern/persistence';
import { InboxModule } from '@plaudern/inbox';
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
import { RecordingMergeService } from './merge/recording-merge.service';
import { RecordingMergeController } from './merge/recording-merge.controller';

@Module({
  imports: [
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
    RecordingMergeService,
  ],
  controllers: [IngestionController, RecordingMergeController],
  exports: [IngestionService, RecordingMergeService],
})
export class IngestionModule {}

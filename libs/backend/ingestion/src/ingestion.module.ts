import { Module } from '@nestjs/common';
import { InboxModule } from '@plaudern/inbox';
import { TranscriptionModule } from '@plaudern/transcription';
import { IngestionService } from './ingestion.service';
import { IngestionController } from './ingestion.controller';
import { SOURCE_ADAPTERS } from './source-adapter';
import { GenericAudioAdapter } from './adapters/generic-audio.adapter';
import { PlaudAdapter } from './adapters/plaud.adapter';
import { TextAdapter } from './adapters/text.adapter';
import { FileAdapter } from './adapters/file.adapter';

@Module({
  imports: [InboxModule, TranscriptionModule],
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
  ],
  controllers: [IngestionController],
  exports: [IngestionService],
})
export class IngestionModule {}

import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InboxModule } from '@plaudern/inbox';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TRANSCRIPTION_PROVIDER } from './transcription.provider';
import { TRANSCRIPTION_QUEUE } from './transcription.job';
import { ElevenLabsTranscriptionProvider } from './providers/elevenlabs.provider';
import { TranscriptionProcessor } from './transcription.processor';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';

@Module({
  imports: [ConfigModule, InboxModule],
  providers: [
    // Transcription always runs on the hosted ElevenLabs Scribe API. The DI
    // token stays as the seam tests override with fakes.
    { provide: TRANSCRIPTION_PROVIDER, useClass: ElevenLabsTranscriptionProvider },
    TranscriptionProcessor,
    {
      provide: TRANSCRIPTION_QUEUE,
      inject: [ConfigService, TranscriptionProcessor],
      useFactory: (config: ConfigService, processor: TranscriptionProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('transcription', 'transcribe', redisConnectionFromConfig(config), processor, {
              concurrency: 2,
              backoffDelayMs: 2_000,
            })
          : new InlineJobQueue(processor),
    },
    TranscriptionService,
  ],
  controllers: [TranscriptionController],
  exports: [TranscriptionService],
})
export class TranscriptionModule {}

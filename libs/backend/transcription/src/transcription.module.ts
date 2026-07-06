import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuditModule } from '@plaudern/audit';
import { InboxModule } from '@plaudern/inbox';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TRANSCRIPTION_PROVIDER } from './transcription.provider';
import { TRANSCRIPTION_QUEUE } from './transcription.job';
import { ElevenLabsTranscriptionProvider } from './providers/elevenlabs.provider';
import { WhisperTranscriptionProvider } from './providers/whisper.provider';
import { DispatchingTranscriptionProvider } from './providers/transcription-dispatch.provider';
import { TranscriptionProcessor } from './transcription.processor';
import { TranscriptionService } from './transcription.service';
import { TranscriptionExtractor } from './transcription.extractor';
import { TranscriptionController } from './transcription.controller';

@Module({
  imports: [ConfigModule, AuditModule, InboxModule],
  providers: [
    ElevenLabsTranscriptionProvider,
    WhisperTranscriptionProvider,
    // TRANSCRIPTION_PROVIDER now dispatches PER USER by the resolved AI config's
    // protocol ('elevenlabs' hosted Scribe API, or 'whisper' — the self-hosted
    // Whisper-compatible tier that keeps sensitive audio off the network, see
    // ATT-662/ATT-687), rather than a boot-time env selection. Tests override
    // this DI token with fakes.
    { provide: TRANSCRIPTION_PROVIDER, useClass: DispatchingTranscriptionProvider },
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
    TranscriptionExtractor,
  ],
  controllers: [TranscriptionController],
  exports: [TranscriptionService, TranscriptionExtractor],
})
export class TranscriptionModule {}

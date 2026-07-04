import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InboxModule } from '@plaudern/inbox';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { TRANSCRIPTION_PROVIDER } from './transcription.provider';
import { TRANSCRIPTION_QUEUE } from './transcription.job';
import { ElevenLabsTranscriptionProvider } from './providers/elevenlabs.provider';
import { WhisperTranscriptionProvider } from './providers/whisper.provider';
import { TranscriptionProcessor } from './transcription.processor';
import { TranscriptionService } from './transcription.service';
import { TranscriptionController } from './transcription.controller';

@Module({
  imports: [ConfigModule, InboxModule],
  providers: [
    ElevenLabsTranscriptionProvider,
    WhisperTranscriptionProvider,
    // TRANSCRIPTION_PROVIDER selects the backend: 'elevenlabs' (default, hosted
    // Scribe API) or 'whisper' (self-hosted Whisper-compatible HTTP server —
    // the local-model tier that keeps sensitive audio off the network, see
    // ATT-662/ATT-687). Tests override this DI token with fakes.
    {
      provide: TRANSCRIPTION_PROVIDER,
      inject: [ConfigService, ElevenLabsTranscriptionProvider, WhisperTranscriptionProvider],
      useFactory: (
        config: ConfigService,
        elevenlabs: ElevenLabsTranscriptionProvider,
        whisper: WhisperTranscriptionProvider,
      ) => {
        const selected = config.get<string>('TRANSCRIPTION_PROVIDER', 'elevenlabs');
        if (selected === 'whisper') return whisper;
        if (selected === 'elevenlabs') return elevenlabs;
        throw new Error(
          `unknown TRANSCRIPTION_PROVIDER '${selected}' (expected 'elevenlabs' or 'whisper')`,
        );
      },
    },
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

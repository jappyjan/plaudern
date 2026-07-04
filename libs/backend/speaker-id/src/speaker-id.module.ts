import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InboxModule } from '@plaudern/inbox';
import { PersistenceModule } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { StorageModule } from '@plaudern/storage';
import { SummarizationModule } from '@plaudern/summarization';
import { DIARIZATION_QUEUE } from './diarization.job';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';
import { CLIP_EXTRACTOR, FfmpegClipExtractor } from './clip-extractor';
import { VoiceprintMatcherService } from './voiceprint-matcher.service';
import { ConsentSettingsService } from './consent-settings.service';
import { DiarizationProcessor } from './diarization.processor';
import { SpeakerIdService } from './speaker-id.service';
import { SpeakerTranscriptService } from './speaker-transcript.service';
import { VoiceProfilesService } from './voice-profiles.service';
import {
  ConsentSettingsController,
  SpeakersController,
  SpeakerTranscriptController,
} from './speakers.controller';

@Module({
  imports: [ConfigModule, InboxModule, PersistenceModule, StorageModule, SummarizationModule],
  controllers: [SpeakersController, SpeakerTranscriptController, ConsentSettingsController],
  providers: [
    // Singleton hosted-API client, shared by the identifier (diarize/identify)
    // and the voiceprint matcher (enrollment). Tests override it with a fake.
    {
      provide: PyannoteAiClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PyannoteAiClient(
          config.get<string>('PYANNOTEAI_BASE_URL', 'https://api.pyannote.ai/v1'),
          config.get<string>('PYANNOTEAI_API_KEY', ''),
          config.get<string>('PYANNOTEAI_MODEL', 'precision-2'),
          Number(config.get<string>('PYANNOTEAI_POLL_INTERVAL_MS', '3000')),
          Number(config.get<string>('PYANNOTEAI_TIMEOUT_MS', String(30 * 60_000))),
        ),
    },
    { provide: CLIP_EXTRACTOR, useClass: FfmpegClipExtractor },
    VoiceprintMatcherService,
    PyannoteAiSpeakerIdentifier,
    DiarizationProcessor,
    {
      provide: DIARIZATION_QUEUE,
      inject: [ConfigService, DiarizationProcessor],
      useFactory: (config: ConfigService, processor: DiarizationProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullJobQueue('diarization', 'diarize', redisConnectionFromConfig(config), processor, {
              // pyannoteAI jobs are mostly polling waits, but one at a time is
              // plenty; retries back off generously.
              concurrency: 1,
              backoffDelayMs: 10_000,
            })
          : new InlineJobQueue(processor),
    },
    SpeakerIdService,
    VoiceProfilesService,
    SpeakerTranscriptService,
    ConsentSettingsService,
  ],
  exports: [SpeakerIdService],
})
export class SpeakerIdModule {}

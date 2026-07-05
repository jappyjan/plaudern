import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { InboxModule } from '@plaudern/inbox';
import { PersistenceModule } from '@plaudern/persistence';
import { BullJobQueue, InlineJobQueue, redisConnectionFromConfig } from '@plaudern/queue';
import { StorageModule } from '@plaudern/storage';
import { SummarizationModule } from '@plaudern/summarization';
import { DIARIZATION_QUEUE } from './diarization.job';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';
import { CLIP_EXTRACTOR, FfmpegClipExtractor } from './clip-extractor';
import { VoiceprintMatcherService } from './voiceprint-matcher.service';
import { ConsentSettingsService } from './consent-settings.service';
import { DiarizationProcessor } from './diarization.processor';
import { SpeakerIdService } from './speaker-id.service';
import { DiarizationExtractor } from './diarization.extractor';
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
    // The hosted-API client is now built per job from the owning user's
    // resolved `speaker_id` config (endpoint/key/model/timeout/poll interval),
    // not from a singleton env-configured instance. The identifier resolves the
    // config and hands the client to the voiceprint matcher.
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
    DiarizationExtractor,
    VoiceProfilesService,
    SpeakerTranscriptService,
    ConsentSettingsService,
  ],
  exports: [SpeakerIdService, DiarizationExtractor],
})
export class SpeakerIdModule {}

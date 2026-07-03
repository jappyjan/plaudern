import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import type { ConnectionOptions } from 'bullmq';
import { InboxModule } from '@plaudern/inbox';
import { PersistenceModule } from '@plaudern/persistence';
import { StorageModule } from '@plaudern/storage';
import { DIARIZATION_PROVIDER } from './diarization.provider';
import { DIARIZATION_QUEUE } from './diarization.job';
import { PyannoteHttpProvider } from './providers/pyannote-http.provider';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { SPEAKER_IDENTIFIER, type SpeakerIdentifier } from './speaker-identifier';
import { EmbeddingSpeakerIdentifier } from './identifiers/embedding.identifier';
import { PyannoteAiSpeakerIdentifier } from './identifiers/pyannoteai.identifier';
import { VoiceprintMatcherService } from './voiceprint-matcher.service';
import { DiarizationProcessor } from './diarization.processor';
import { ProfileMatcherService } from './profile-matcher.service';
import { SpeakerIdService } from './speaker-id.service';
import { SpeakerTranscriptService } from './speaker-transcript.service';
import { VoiceProfilesService } from './voice-profiles.service';
import { SpeakersController, SpeakerTranscriptController } from './speakers.controller';
import { InlineDiarizationQueue } from './queues/inline.queue';
import { BullDiarizationQueue } from './queues/bull.queue';

function redisConnection(config: ConfigService): ConnectionOptions {
  const url = config.get<string>('REDIS_URL');
  if (url) {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || '6379'),
      password: parsed.password || undefined,
      username: parsed.username || undefined,
      db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
    };
  }
  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: Number(config.get<string>('REDIS_PORT', '6379')),
  };
}

@Module({
  imports: [ConfigModule, InboxModule, PersistenceModule, StorageModule],
  controllers: [SpeakersController, SpeakerTranscriptController],
  providers: [
    // Raw sidecar diarization provider, consumed by the embedding identifier.
    { provide: DIARIZATION_PROVIDER, useClass: PyannoteHttpProvider },
    // Singleton hosted-API client, shared by the pyannoteAI identifier (diarize
    // /identify) and the voiceprint matcher (enrollment).
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
    ProfileMatcherService,
    VoiceprintMatcherService,
    EmbeddingSpeakerIdentifier,
    PyannoteAiSpeakerIdentifier,
    {
      provide: SPEAKER_IDENTIFIER,
      inject: [ConfigService, EmbeddingSpeakerIdentifier, PyannoteAiSpeakerIdentifier],
      useFactory: (
        config: ConfigService,
        embedding: EmbeddingSpeakerIdentifier,
        pyannoteai: PyannoteAiSpeakerIdentifier,
      ): SpeakerIdentifier => {
        const selected = config.get<string>('SPEAKER_ID_PROVIDER', 'pyannote');
        switch (selected) {
          case 'pyannote':
          case 'off': // SpeakerIdService never enqueues; the instance is inert
            return embedding;
          case 'pyannoteai':
            if (!config.get<string>('PYANNOTEAI_API_KEY')) {
              throw new Error(
                'SPEAKER_ID_PROVIDER=pyannoteai requires PYANNOTEAI_API_KEY (get one at pyannote.ai)',
              );
            }
            return pyannoteai;
          case 'stub':
            throw new Error(
              "SPEAKER_ID_PROVIDER=stub was removed; use 'pyannote', 'pyannoteai', or 'off'",
            );
          default:
            throw new Error(
              `unknown SPEAKER_ID_PROVIDER '${selected}' (expected 'pyannote', 'pyannoteai', or 'off')`,
            );
        }
      },
    },
    DiarizationProcessor,
    {
      provide: DIARIZATION_QUEUE,
      inject: [ConfigService, DiarizationProcessor],
      useFactory: (config: ConfigService, processor: DiarizationProcessor) =>
        config.get<string>('QUEUE_DRIVER', 'inline') === 'bull'
          ? new BullDiarizationQueue(redisConnection(config), processor)
          : new InlineDiarizationQueue(processor),
    },
    SpeakerIdService,
    VoiceProfilesService,
    SpeakerTranscriptService,
  ],
  exports: [SpeakerIdService],
})
export class SpeakerIdModule {}

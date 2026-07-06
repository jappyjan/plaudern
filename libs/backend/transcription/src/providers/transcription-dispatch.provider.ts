import { Injectable } from '@nestjs/common';
import { AiConfigService, type ResolvedAiConfig } from '@plaudern/ai-config';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';
import { ElevenLabsTranscriptionProvider } from './elevenlabs.provider';
import { WhisperTranscriptionProvider } from './whisper.provider';

/**
 * Facade bound to the `TRANSCRIPTION_PROVIDER` token. Selection is no longer a
 * boot-time env choice: for each call it resolves the user's transcription
 * config and dispatches by the connection's `protocol` (`whisper` → the
 * self-hosted Whisper-compatible backend, otherwise the hosted ElevenLabs
 * Scribe API). A null resolution means the user has no transcription provider
 * assigned, surfaced as `isEnabled` false / a friendly error on use.
 */
@Injectable()
export class DispatchingTranscriptionProvider implements TranscriptionProvider {
  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly elevenlabs: ElevenLabsTranscriptionProvider,
    private readonly whisper: WhisperTranscriptionProvider,
  ) {}

  isEnabled(userId: string): Promise<boolean> {
    return this.aiConfig.isEnabled(userId, 'transcription');
  }

  async providerId(userId: string): Promise<string> {
    // Never throws: this only labels the extraction row at enqueue time. When
    // the user has no transcription provider, the row is still created (with a
    // placeholder label) and the actual failure surfaces on `transcribe` as a
    // failed row — matching the pre-DB-config behavior — rather than breaking
    // the commit flow before the row exists.
    const cfg = await this.aiConfig.resolve(userId, 'transcription');
    if (!cfg) return 'transcription';
    return cfg.protocol === 'whisper' ? `whisper:${cfg.model}` : 'elevenlabs-scribe';
  }

  async transcribe(userId: string, input: TranscriptionInput): Promise<TranscriptionResult> {
    const cfg = await this.requireConfig(userId);
    if (cfg.protocol === 'whisper') {
      return this.whisper.transcribe(userId, input);
    }
    return this.elevenlabs.transcribe(userId, input);
  }

  private async requireConfig(userId: string): Promise<ResolvedAiConfig> {
    const cfg = await this.aiConfig.resolve(userId, 'transcription');
    if (!cfg) {
      throw new Error(
        'transcription is not configured — assign a provider in Settings → AI',
      );
    }
    return cfg;
  }
}

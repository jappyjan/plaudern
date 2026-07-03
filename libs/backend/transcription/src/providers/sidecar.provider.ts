import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';
import { postJsonToSidecar } from './sidecar-http';

/**
 * Calls the self-hosted ML sidecar (apps/speaker-id-ml) over HTTP. The sidecar
 * downloads the presigned audio URL itself, so no bytes flow through the API
 * process. Shares SPEAKER_ID_URL/SPEAKER_ID_TOKEN with the diarization
 * provider — there is exactly one sidecar service.
 */
@Injectable()
export class SidecarTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'whisper-sidecar';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('SPEAKER_ID_URL', 'http://localhost:8000');
    this.token = config.get<string>('SPEAKER_ID_TOKEN', '');
    // CPU transcription runs at roughly real time.
    this.timeoutMs = Number(
      config.get<string>('TRANSCRIPTION_TIMEOUT_MS', String(30 * 60_000)),
    );
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const json = await postJsonToSidecar<{
      text: string;
      language?: string;
      segments?: { start: number; end: number; text: string }[];
    }>(
      `${this.baseUrl}/transcribe`,
      { audio_url: input.audioUrl, language: input.languageHint ?? null },
      this.token,
      this.timeoutMs,
    );
    return {
      text: json.text,
      language: json.language,
      segments: json.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      raw: json,
    };
  }
}

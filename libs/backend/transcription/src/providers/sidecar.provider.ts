import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';

/**
 * Calls the self-hosted ML sidecar (apps/speaker-id-ml) over HTTP. The sidecar
 * downloads the presigned audio URL itself, so no bytes flow through the API
 * process. Shares SPEAKER_ID_URL/SPEAKER_ID_TOKEN with the diarization
 * provider — there is exactly one sidecar service.
 */
@Injectable()
export class SidecarTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'whisper-sidecar';
  private readonly logger = new Logger(SidecarTranscriptionProvider.name);
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
    const res = await fetch(`${this.baseUrl}/transcribe`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        audio_url: input.audioUrl,
        language: input.languageHint ?? null,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`transcription failed: ${res.status} ${body}`);
      throw new Error(`transcription provider error ${res.status}`);
    }

    const json = (await res.json()) as {
      text: string;
      language?: string;
      segments?: { start: number; end: number; text: string }[];
    };
    return {
      text: json.text,
      language: json.language,
      segments: json.segments?.map((s) => ({ start: s.start, end: s.end, text: s.text })),
      raw: json,
    };
  }
}

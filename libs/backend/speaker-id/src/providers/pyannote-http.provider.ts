import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DiarizationInput,
  DiarizationProvider,
  DiarizationResult,
} from '../diarization.provider';

/**
 * Calls the self-hosted pyannote sidecar (apps/speaker-id-ml) over HTTP. The
 * sidecar downloads the presigned audio URL itself, so no bytes flow through
 * the API process.
 */
@Injectable()
export class PyannoteHttpProvider implements DiarizationProvider {
  readonly id = 'pyannote-sidecar';
  private readonly logger = new Logger(PyannoteHttpProvider.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('SPEAKER_ID_URL', 'http://localhost:8000');
    this.token = config.get<string>('SPEAKER_ID_TOKEN', '');
    // CPU diarization can take minutes per hour of audio.
    this.timeoutMs = Number(config.get<string>('SPEAKER_ID_TIMEOUT_MS', String(30 * 60_000)));
  }

  async diarize(input: DiarizationInput): Promise<DiarizationResult> {
    const res = await fetch(`${this.baseUrl}/diarize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ audio_url: input.audioUrl }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      this.logger.error(`diarization failed: ${res.status} ${body}`);
      throw new Error(`diarization provider error ${res.status}`);
    }

    const json = (await res.json()) as {
      duration_seconds: number;
      segments: { start: number; end: number; speaker: string }[];
      speakers: { label: string; embedding: number[]; speaking_seconds: number }[];
    };
    return {
      durationSeconds: json.duration_seconds,
      segments: json.segments,
      speakers: json.speakers.map((s) => ({
        label: s.label,
        embedding: s.embedding,
        speakingSeconds: s.speaking_seconds,
      })),
    };
  }
}

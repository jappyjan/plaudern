import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';
import { downloadBytes, postMultipartForJson } from './http-helpers';

interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

interface WhisperResponse {
  text: string;
  /** Whisper backends report the full language name (e.g. "english"). */
  language?: string;
  segments?: WhisperSegment[];
}

/**
 * Transcribes via a self-hosted Whisper-compatible HTTP server that exposes
 * the OpenAI `/v1/audio/transcriptions` contract — e.g.
 * [faster-whisper-server](https://github.com/speaches-ai/speaches) or
 * whisper.cpp's built-in server. No model weights or binaries ship with this
 * app; point WHISPER_BASE_URL at wherever that server runs (same box, a LAN
 * machine with a GPU, …) and it does the actual decoding.
 *
 * This is the "local model tier": selected via TRANSCRIPTION_PROVIDER=whisper,
 * audio never leaves the operator's own infrastructure, which is what the
 * sensitivity-routing feature (ATT-687) needs for content that must stay
 * local. We still download the audio from the presigned INTERNAL storage URL
 * and push the bytes to the configured server, mirroring the ElevenLabs
 * provider's push model.
 */
@Injectable()
export class WhisperTranscriptionProvider implements TranscriptionProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .get<string>('WHISPER_BASE_URL', 'http://localhost:8000/v1')
      .replace(/\/+$/, '');
    this.apiKey = config.get<string>('WHISPER_API_KEY', '');
    // Must match a model the server actually has loaded/can load; the default
    // is what faster-whisper-server/speaches ship as a small CPU-friendly
    // model. whisper.cpp servers generally ignore this field.
    this.model = config.get<string>('WHISPER_MODEL', 'Systran/faster-whisper-small');
    // Local CPU inference can be much slower than a hosted API; default higher
    // than ElevenLabs' timeout.
    this.timeoutMs = Number(config.get<string>('WHISPER_TIMEOUT_MS', String(20 * 60_000)));
    this.downloadTimeoutMs = Number(
      config.get<string>('WHISPER_DOWNLOAD_TIMEOUT_MS', String(5 * 60_000)),
    );
    this.id = `whisper:${this.model}`;
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    const bytes = await downloadBytes(input.audioUrl, this.downloadTimeoutMs);

    const fields = [
      { name: 'model', value: this.model },
      { name: 'response_format', value: 'verbose_json' },
    ];
    if (input.languageHint) {
      fields.push({ name: 'language', value: input.languageHint });
    }

    // Most local Whisper servers need no auth at all; only send the header
    // when a key was actually configured, so we don't hand a strict server a
    // malformed `Bearer ` value.
    const headers: Record<string, string> = {};
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const json = await postMultipartForJson<WhisperResponse>(
      `${this.baseUrl}/audio/transcriptions`,
      fields,
      {
        name: 'file',
        filename: input.filename ?? 'audio',
        contentType: input.contentType || 'application/octet-stream',
        bytes,
      },
      headers,
      this.timeoutMs,
      'Whisper',
    );

    return {
      text: json.text ?? '',
      language: normalizeWhisperLanguage(json.language),
      segments: mapWhisperSegments(json.segments),
      raw: json,
    };
  }
}

/** Drop empty segments and trim text; whisper.cpp/faster-whisper already give
 * {start,end,text} in the shape the rest of the app expects. */
export function mapWhisperSegments(
  segments: WhisperSegment[] | undefined,
): { start: number; end: number; text: string }[] | undefined {
  if (!segments || segments.length === 0) return undefined;
  const mapped = segments
    .map((s) => ({ start: s.start, end: s.end, text: (s.text ?? '').trim() }))
    .filter((s) => s.text.length > 0);
  return mapped.length > 0 ? mapped : undefined;
}

/** Full language names (as returned by OpenAI-compatible Whisper endpoints),
 * mapped to the 2-letter codes the rest of the app stores. Passes through
 * anything already 2-letter or otherwise unmapped. */
const NAME_TO_ISO1: Record<string, string> = {
  english: 'en', german: 'de', french: 'fr', spanish: 'es', italian: 'it',
  dutch: 'nl', portuguese: 'pt', russian: 'ru', polish: 'pl', turkish: 'tr',
  ukrainian: 'uk', czech: 'cs', romanian: 'ro', swedish: 'sv', danish: 'da',
  norwegian: 'no', finnish: 'fi', greek: 'el', hungarian: 'hu', bulgarian: 'bg',
  croatian: 'hr', slovak: 'sk', slovenian: 'sl', catalan: 'ca', japanese: 'ja',
  korean: 'ko', chinese: 'zh', arabic: 'ar', hebrew: 'he', hindi: 'hi',
  thai: 'th', vietnamese: 'vi', indonesian: 'id', malay: 'ms',
};

/**
 * Normalize a Whisper backend's `language` field (full name, e.g. "english"
 * or "English") to the 2-letter code the rest of the app stores (matching
 * ElevenLabsTranscriptionProvider's normalizeLanguage).
 */
export function normalizeWhisperLanguage(language: string | undefined): string | undefined {
  if (!language) return undefined;
  const l = language.trim().toLowerCase();
  if (l.length === 2) return l;
  return NAME_TO_ISO1[l] ?? l;
}

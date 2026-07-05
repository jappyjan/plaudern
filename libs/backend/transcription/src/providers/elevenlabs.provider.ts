import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiAuditRecorder } from '@plaudern/audit';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '../transcription.provider';
import { downloadBytes, postMultipartForJson } from './http-helpers';

/** One entry in ElevenLabs Scribe's `words` array (word-level granularity). */
interface ScribeWord {
  text: string;
  start?: number;
  end?: number;
  /** 'word' | 'spacing' | 'audio_event' */
  type?: string;
  speaker_id?: string;
}

interface ScribeResponse {
  text: string;
  language_code?: string;
  words?: ScribeWord[];
}

/** Start a new segment when the silence between two words exceeds this. */
const GAP_SPLIT_SECONDS = 0.8;
/** Cap a segment's span so a run-on utterance still attributes cleanly. */
const MAX_SEGMENT_SECONDS = 14;

/**
 * Transcribes via the hosted ElevenLabs Scribe API (scribe_v2).
 *
 * We download the audio from the presigned INTERNAL storage URL (reachable from
 * the API process) and upload the bytes to ElevenLabs — we push, they never
 * pull, so the storage endpoint never has to be internet-reachable and no
 * presigned URL into our storage is handed to a third party.
 *
 * Diarization stays on pyannoteAI (speaker labels come from there and merge at
 * read time), so we ask Scribe only for text + word timestamps and reduce its
 * word list to whisper-style segments the diarization overlap merge can
 * attribute.
 */
@Injectable()
export class ElevenLabsTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'elevenlabs-scribe';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly tagAudioEvents: boolean;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly audit: AiAuditRecorder,
  ) {
    this.baseUrl = config.get<string>('ELEVENLABS_BASE_URL', 'https://api.elevenlabs.io/v1');
    this.apiKey = config.get<string>('ELEVENLABS_API_KEY', '');
    this.model = config.get<string>('ELEVENLABS_STT_MODEL', 'scribe_v2');
    this.tagAudioEvents =
      config.get<string>('ELEVENLABS_TAG_AUDIO_EVENTS', 'false') === 'true';
    // ElevenLabs is silent until the whole transcript is ready; this bounds the
    // total wait (default 30 min).
    this.timeoutMs = Number(
      config.get<string>('ELEVENLABS_STT_TIMEOUT_MS', String(30 * 60_000)),
    );
    this.downloadTimeoutMs = Number(
      config.get<string>('ELEVENLABS_DOWNLOAD_TIMEOUT_MS', String(5 * 60_000)),
    );
  }

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    if (!this.apiKey) {
      throw new Error(
        'ELEVENLABS_API_KEY is not set — cannot transcribe with the ElevenLabs provider',
      );
    }

    const bytes = await downloadBytes(input.audioUrl, this.downloadTimeoutMs);

    const fields = [
      { name: 'model_id', value: this.model },
      { name: 'timestamps_granularity', value: 'word' },
      // Diarization is handled elsewhere; we only need text + word timings.
      { name: 'diarize', value: 'false' },
      { name: 'tag_audio_events', value: this.tagAudioEvents ? 'true' : 'false' },
    ];
    if (input.languageHint) {
      fields.push({ name: 'language_code', value: input.languageHint });
    }

    const endpoint = `${this.baseUrl}/speech-to-text`;
    // Audit the audio bytes leaving the box for the hosted provider (JJ-42).
    await this.audit.record({ provider: this.id, endpoint, payload: bytes });
    const json = await postMultipartForJson<ScribeResponse>(
      endpoint,
      fields,
      {
        name: 'file',
        filename: input.filename ?? 'audio',
        contentType: input.contentType || 'application/octet-stream',
        bytes,
      },
      { 'xi-api-key': this.apiKey },
      this.timeoutMs,
      'ElevenLabs',
    );

    const segments = wordsToSegments(json.words ?? []);
    return {
      text: json.text ?? '',
      language: normalizeLanguage(json.language_code),
      segments: segments.length > 0 ? segments : undefined,
      raw: json,
    };
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Reduce Scribe's word-level list into whisper-style {start,end,text} segments.
 * A new segment starts on a sentence-ending word, a silence gap, a speaker
 * change, or when the span grows too long — finer than one block per speaker so
 * the diarization overlap merge (attributeSegments) stays accurate, but coarse
 * enough to read naturally. `spacing` entries carry the whitespace between
 * words and are appended verbatim so the reconstructed text keeps its spacing.
 */
export function wordsToSegments(
  words: ScribeWord[],
): { start: number; end: number; text: string }[] {
  const segments: { start: number; end: number; text: string }[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  let prevSpeaker: string | null = null;
  let endSentence = false;

  const flush = () => {
    if (!cur) return;
    const text = cur.text.trim();
    if (text) segments.push({ start: round(cur.start), end: round(cur.end), text });
    cur = null;
  };

  for (const w of words) {
    // `spacing` entries carry only the whitespace between words: append their
    // text so spacing is preserved, but never let them move segment boundaries
    // or timestamps — those come from real words.
    if (w.type === 'spacing') {
      if (cur) cur.text += w.text ?? '';
      continue;
    }

    const start: number = typeof w.start === 'number' ? w.start : cur?.end ?? 0;
    const end: number = typeof w.end === 'number' ? w.end : start;
    const speaker = w.speaker_id ?? null;

    if (cur) {
      const gap = start - cur.end;
      const tooLong = end - cur.start > MAX_SEGMENT_SECONDS;
      const speakerChanged =
        prevSpeaker !== null && speaker !== null && speaker !== prevSpeaker;
      if (endSentence || gap > GAP_SPLIT_SECONDS || tooLong || speakerChanged) {
        flush();
        endSentence = false;
      }
    }

    if (!cur) cur = { start, end, text: '' };
    cur.text += w.text ?? '';
    cur.end = Math.max(cur.end, end);
    prevSpeaker = speaker;
    if (/[.!?…]["')\]]?$/.test((w.text ?? '').trim())) endSentence = true;
  }
  flush();
  return segments;
}

/** ISO 639-3 codes Scribe may return, mapped to the 2-letter codes we store. */
const ISO3_TO_ISO1: Record<string, string> = {
  eng: 'en', deu: 'de', ger: 'de', fra: 'fr', fre: 'fr', spa: 'es', ita: 'it',
  nld: 'nl', dut: 'nl', por: 'pt', rus: 'ru', pol: 'pl', tur: 'tr', ukr: 'uk',
  ces: 'cs', cze: 'cs', ron: 'ro', rum: 'ro', swe: 'sv', dan: 'da', nor: 'no',
  fin: 'fi', ell: 'el', gre: 'el', hun: 'hu', bul: 'bg', hrv: 'hr', slk: 'sk',
  slo: 'sk', slv: 'sl', cat: 'ca', jpn: 'ja', kor: 'ko', zho: 'zh', chi: 'zh',
  ara: 'ar', heb: 'he', hin: 'hi', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms',
  may: 'ms',
};

/**
 * Normalize Scribe's language_code to the 2-letter form the rest of the app
 * stores (faster-whisper reported ISO 639-1). Passes through anything already
 * 2-letter or otherwise unmapped.
 */
export function normalizeLanguage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const c = code.trim().toLowerCase();
  if (c.length === 2) return c;
  if (c.length === 3) return ISO3_TO_ISO1[c] ?? c;
  return c;
}

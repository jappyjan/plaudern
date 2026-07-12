import { createHash } from 'node:crypto';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '@plaudern/transcription';
import type {
  ClipExtractor,
  ClipSpeaker,
  PyannoteAiDiarization,
  PyannoteAiVoiceprint,
  VoiceprintClip,
} from '@plaudern/speaker-id';
import type {
  SummarizationInput,
  SummarizationProvider,
  SummarizationResult,
} from '@plaudern/summarization';
import type { EmbeddingProvider, EmbeddingResult } from '@plaudern/embeddings';
import type {
  EntityExtractionInput,
  EntityExtractionProvider,
  EntityExtractionResult,
} from '@plaudern/entities';
import type { AudioConcatenator, ConcatResult } from '@plaudern/ingestion';

/**
 * Deterministic test doubles for the hosted-API pipeline. The fakes share one
 * world model so the REAL identifier + voiceprint matcher run end-to-end
 * without network or ffmpeg:
 *
 *   Every recording has two speakers — 0–8s a CONSTANT voice (the same person
 *   in every recording) and 8–16s a per-recording voice. The clip extractor
 *   emits clip bytes accordingly, voiceprints are content hashes of clip
 *   bytes, and /identify relabels the constant-voice segment with the known
 *   profile whose voiceprint matches. So across recordings the constant voice
 *   converges on ONE profile while each per-recording voice gets a fresh one.
 */

const CONSTANT_VOICE = Buffer.from('fake-voice-constant');

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const voiceprintOf = (bytes: Buffer) => `vp:${sha(bytes)}`;

/**
 * Deterministic transcription double, injected via
 * overrideProvider(TRANSCRIPTION_PROVIDER). Returns fixed text with timestamps
 * aligned to the fake diarization (0–8s / 8–16s).
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'fake-transcription';

  async isEnabled(): Promise<boolean> {
    return true;
  }

  async providerId(): Promise<string> {
    return this.id;
  }

  async transcribe(_userId: string, input: TranscriptionInput): Promise<TranscriptionResult> {
    return {
      text: `[test transcription, ${input.contentType}]`,
      language: 'en',
      segments: [
        { start: 0, end: 8, text: `[test transcription,` },
        { start: 8, end: 16, text: ` ${input.contentType}]` },
      ],
    };
  }
}

/**
 * Clip-extractor double, injected via overrideProvider(CLIP_EXTRACTOR). The
 * first-heard speaker (SPEAKER_00, the 0–8s window) is the constant voice;
 * every other speaker's clip is derived from the recording's storage key, so
 * distinct recordings yield distinct voiceprints.
 */
export class FakeClipExtractor implements ClipExtractor {
  async extract(
    storageKey: string,
    speakers: ClipSpeaker[],
    _maxSeconds: number,
  ): Promise<VoiceprintClip[]> {
    return speakers.map((speaker) => ({
      label: speaker.label,
      wav:
        speaker.label === 'SPEAKER_00'
          ? CONSTANT_VOICE
          : Buffer.from(`fake-voice-${storageKey}-${speaker.label}`),
    }));
  }
}

/**
 * ffmpeg-free concatenator double, injected via
 * overrideProvider(AUDIO_CONCATENATOR). Every part is reported as 16 s long,
 * matching the fakes' shared world model (0–8 s constant voice, 8–16 s
 * per-recording voice), so merged segment offsets are exactly 16 * i.
 */
export class FakeAudioConcatenator implements AudioConcatenator {
  async concat(storageKeys: string[]): Promise<ConcatResult> {
    return {
      bytes: Buffer.from(`fake-merged:${storageKeys.join('+')}`),
      contentType: 'audio/mpeg',
      durationsSeconds: storageKeys.map(() => 16),
    };
  }
}

/**
 * Hosted-API double, injected via overrideProvider(PyannoteAiClient). Mirrors
 * the real client's surface: upload() returns a media:// handle, voiceprint()
 * hashes the uploaded clip, diarize()/identify() return the fixed two-speaker
 * diarization — with the constant voice relabeled to its matching known
 * voiceprint's label, like the real /identify.
 */
export class FakePyannoteAiClient {
  private readonly uploads = new Map<string, Buffer>();

  async upload(bytes: Buffer, _contentType: string, keyHint: string): Promise<string> {
    const url = `media://fake/${keyHint}`;
    this.uploads.set(url, bytes);
    return url;
  }

  async voiceprint(mediaUrl: string): Promise<string> {
    const bytes = this.uploads.get(mediaUrl);
    if (!bytes) throw new Error(`fake pyannoteAI: unknown media url ${mediaUrl}`);
    return voiceprintOf(bytes);
  }

  async diarize(_mediaUrl: string): Promise<PyannoteAiDiarization> {
    return {
      durationSeconds: 16,
      segments: [
        { start: 0, end: 8, speaker: 'SPEAKER_00' },
        { start: 8, end: 16, speaker: 'SPEAKER_01' },
      ],
    };
  }

  async identify(
    mediaUrl: string,
    voiceprints: PyannoteAiVoiceprint[],
    _threshold: number,
  ): Promise<PyannoteAiDiarization> {
    const diarization = await this.diarize(mediaUrl);
    const known = voiceprints.find((v) => v.voiceprint === voiceprintOf(CONSTANT_VOICE));
    if (known) diarization.segments[0].speaker = known.label;
    return diarization;
  }
}

/**
 * Deterministic test double, injected via overrideProvider(SUMMARIZATION_PROVIDER).
 * Echoes the roster back as `@[LABEL]` mentions so tests can assert the whole
 * transcribe → diarize → summarize chain and mention resolution end to end.
 */
export class FakeSummarizationProvider implements SummarizationProvider {
  readonly id = 'fake-summarization';

  async summarize(_userId: string, input: SummarizationInput): Promise<SummarizationResult> {
    const mentions = input.speakers.map((s) => `@[${s.label}]`).join(' and ');
    const markdown = [
      '## Summary',
      // Echo the forced output language so tests can assert the per-user
      // language preference reaches the provider.
      `Language: ${input.targetLanguage ?? 'auto'}.`,
      mentions ? `Speakers: ${mentions}.` : 'No speakers detected.',
      '',
      '```mermaid',
      'flowchart TD',
      '  A[Start] --> B[End]',
      '```',
    ].join('\n');
    return {
      title: 'Test summary title',
      layout: input.speakers.length > 1 ? 'meeting' : 'note',
      markdown,
      offTopic: '- Off-topic aside for testing.',
      model: 'fake-model',
    };
  }
}

/** Dimension the fake emits — matches the `vector(1536)` migration column. */
export const FAKE_EMBEDDING_DIMENSIONS = 1536;

/**
 * Deterministic embedding double, injected via overrideProvider(EMBEDDING_PROVIDER).
 * Same text => same vector (a seeded LCG over a content hash), so tests can
 * assert stable chunking/persistence and — on the real pgvector path — that a
 * chunk is its own nearest neighbour under cosine distance. Emits 1536-dim
 * vectors to fill the `vector(1536)` column exactly.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake-embedding';
  private readonly dimensions = FAKE_EMBEDDING_DIMENSIONS;

  async isEnabled(): Promise<boolean> {
    return true;
  }

  async embed(_userId: string, texts: string[]): Promise<EmbeddingResult> {
    return {
      vectors: texts.map((text) => deterministicVector(text, this.dimensions)),
      model: 'fake-embedding-model',
      dimensions: this.dimensions,
    };
  }
}

/**
 * Deterministic entity-extraction double, injected via
 * overrideProvider(ENTITY_EXTRACTION_PROVIDER). Pulls capitalized tokens out of
 * the input text as organization entities, so the result is derived from — and
 * proves consumption of — whatever source text (transcript or OCR) it was given.
 */
export class FakeEntityProvider implements EntityExtractionProvider {
  readonly id = 'fake-entity';

  async extract(_userId: string, input: EntityExtractionInput): Promise<EntityExtractionResult> {
    const names = Array.from(
      new Set((input.text.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? []).slice(0, 5)),
    );
    return {
      entities: names.map((name) => ({ type: 'organization' as const, name, mentions: [name] })),
      model: 'fake-entity-model',
    };
  }
}

/** Reproducible pseudo-random unit-ish vector seeded from the text's hash. */
export function deterministicVector(text: string, dimensions: number): number[] {
  let state = parseInt(sha(Buffer.from(text)).slice(0, 8), 16) >>> 0;
  const out = new Array<number>(dimensions);
  for (let i = 0; i < dimensions; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state / 2 ** 32) * 2 - 1;
  }
  return out;
}

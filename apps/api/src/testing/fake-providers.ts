import { createHash } from 'node:crypto';
import type {
  TranscriptionInput,
  TranscriptionProvider,
  TranscriptionResult,
} from '@plaudern/transcription';
import type {
  DiarizationInput,
  DiarizationProvider,
  DiarizationResult,
} from '@plaudern/speaker-id';

/**
 * Deterministic test double, injected via overrideProvider(TRANSCRIPTION_PROVIDER).
 * Drains the stream (so the storage read path is genuinely exercised) and
 * returns fixed text with timestamps aligned to FakeDiarizationProvider.
 */
export class FakeTranscriptionProvider implements TranscriptionProvider {
  readonly id = 'fake-transcription';

  async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
    let bytes = 0;
    const stream = await input.openStream();
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
    }
    return {
      text: `[test transcription of ${bytes} bytes, ${input.contentType}]`,
      language: 'en',
      segments: [
        { start: 0, end: 2, text: `[test transcription of ${bytes} bytes,` },
        { start: 2, end: 4, text: ` ${input.contentType}]` },
      ],
    };
  }
}

const DIM = 64;

/**
 * Deterministic test double, injected via overrideProvider(DIARIZATION_PROVIDER).
 * Emits two speakers per recording: SPEAKER_00 has a constant embedding so it
 * matches the SAME profile across every recording; SPEAKER_01's embedding is a
 * ±1 sign vector derived from the audio URL hash, so distinct recordings yield
 * near-orthogonal embeddings (cosine ≈ 0 ± 1/8) and therefore distinct
 * unconfirmed profiles.
 */
export class FakeDiarizationProvider implements DiarizationProvider {
  readonly id = 'fake-diarization';

  async diarize(input: DiarizationInput): Promise<DiarizationResult> {
    const constant = new Array<number>(DIM).fill(0);
    constant[0] = 1;

    const hash = createHash('sha256').update(input.audioUrl).digest();
    const scale = 1 / Math.sqrt(DIM);
    const hashed = Array.from({ length: DIM }, (_, i) => {
      const bit = (hash[i >> 3] >> (i & 7)) & 1;
      return bit ? scale : -scale;
    });

    return {
      durationSeconds: 4,
      segments: [
        { start: 0, end: 2, speaker: 'SPEAKER_00' },
        { start: 2, end: 4, speaker: 'SPEAKER_01' },
      ],
      speakers: [
        { label: 'SPEAKER_00', embedding: constant, speakingSeconds: 2 },
        { label: 'SPEAKER_01', embedding: hashed, speakingSeconds: 2 },
      ],
    };
  }
}

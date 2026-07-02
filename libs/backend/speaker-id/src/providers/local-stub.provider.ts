import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  DiarizationInput,
  DiarizationProvider,
  DiarizationResult,
} from '../diarization.provider';

const DIM = 64;

/**
 * Deterministic stub for CI/offline. Emits two speakers per recording:
 * SPEAKER_00 has a constant embedding so it matches the SAME profile across
 * every recording; SPEAKER_01's embedding is a ±1 sign vector derived from the
 * audio URL hash, so distinct recordings yield near-orthogonal embeddings
 * (cosine ≈ 0 ± 1/8) and therefore distinct unconfirmed profiles.
 */
@Injectable()
export class LocalStubDiarizationProvider implements DiarizationProvider {
  readonly id = 'diarization-stub';

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

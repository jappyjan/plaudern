export interface DiarizationInput {
  /** Presigned GET URL the provider downloads the audio from. */
  audioUrl: string;
  contentType: string;
}

export interface DiarizedSpeaker {
  /** Per-recording label, e.g. SPEAKER_00. */
  label: string;
  /** L2-normalized voice embedding for cross-recording matching. */
  embedding: number[];
  speakingSeconds: number;
}

export interface DiarizationResult {
  durationSeconds: number;
  segments: { start: number; end: number; speaker: string }[];
  speakers: DiarizedSpeaker[];
}

/**
 * Pluggable diarization backend. Concrete impls: the pyannote sidecar over
 * HTTP for real use, a local stub for CI/offline. Selected via env at module
 * init, mirroring the transcription provider pattern.
 */
export interface DiarizationProvider {
  readonly id: string;
  diarize(input: DiarizationInput): Promise<DiarizationResult>;
}

export const DIARIZATION_PROVIDER = Symbol('DIARIZATION_PROVIDER');

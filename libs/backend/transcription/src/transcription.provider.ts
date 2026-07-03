export interface TranscriptionInput {
  /** Presigned internal GET URL; the sidecar downloads it itself. */
  audioUrl: string;
  contentType: string;
  filename?: string;
  languageHint?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
  segments?: { start: number; end: number; text: string }[];
  raw?: unknown;
}

/**
 * Transcription backend (plan §5): the self-hosted whisper sidecar
 * (apps/speaker-id-ml). Tests override the DI token with fakes.
 */
export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

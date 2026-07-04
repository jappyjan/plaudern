export interface TranscriptionInput {
  /** Presigned internal GET URL the provider downloads the audio from. */
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
 * Transcription backend: the hosted ElevenLabs Scribe API. Tests override the
 * DI token with fakes.
 */
export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

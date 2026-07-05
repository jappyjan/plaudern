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
 * Transcription backend facade bound to the `TRANSCRIPTION_PROVIDER` token.
 * Which concrete backend runs is decided PER USER by the resolved AI config's
 * `protocol` (elevenlabs / whisper), not by a boot-time env selection. Tests
 * override the DI token with fakes.
 */
export interface TranscriptionProvider {
  /** Whether transcription is configured for this user. */
  isEnabled(userId: string): Promise<boolean>;
  /** Provider id recorded on the extraction row, per the user's resolved config. */
  providerId(userId: string): Promise<string>;
  transcribe(userId: string, input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

import { Readable } from 'node:stream';

export interface TranscriptionInput {
  /** Presigned internal GET URL; server-network providers download it themselves. */
  audioUrl: string;
  /** Lazily opens the source stream, for providers that upload the bytes (OpenAI). */
  openStream: () => Promise<Readable>;
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
 * Pluggable transcription backend (plan §5). Concrete impls: the self-hosted
 * whisper sidecar (default) or the OpenAI Whisper API. Selected via env at
 * module init; tests override the DI token with fakes.
 */
export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

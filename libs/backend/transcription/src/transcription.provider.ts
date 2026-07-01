import { Readable } from 'node:stream';

export interface TranscriptionInput {
  stream: Readable;
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
 * Pluggable transcription backend (plan §5). Concrete impls: OpenAI Whisper for
 * real use, a local stub for CI/offline. Selected via env at module init.
 */
export interface TranscriptionProvider {
  readonly id: string;
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export const TRANSCRIPTION_PROVIDER = Symbol('TRANSCRIPTION_PROVIDER');

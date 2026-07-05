import { z } from 'zod';

/**
 * The kind of input an inbox item originates from. New source types (e.g. more
 * hardware integrations) plug in by adding a value here plus a backend adapter.
 */
export const SourceType = {
  Audio: 'audio',
  Text: 'text',
  File: 'file',
  Plaud: 'plaud',
  Web: 'web',
  Email: 'email',
} as const;

export const sourceTypeSchema = z.enum(['audio', 'text', 'file', 'plaud', 'web', 'email']);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/** Source types whose payload is audio and therefore get transcribed on commit. */
export const AUDIO_BEARING_SOURCE_TYPES: readonly SourceType[] = ['audio', 'plaud'];

export function isAudioBearing(sourceType: SourceType): boolean {
  return AUDIO_BEARING_SOURCE_TYPES.includes(sourceType);
}

/**
 * Source types whose payload is the note text itself. Their content enters the
 * extraction DAG via a passthrough "transcription" row instead of a speech
 * provider. Extend with 'web'/'email' once those adapters derive extractions.
 */
export const TEXT_BEARING_SOURCE_TYPES: readonly SourceType[] = ['text'];

export function isTextBearing(sourceType: SourceType): boolean {
  return TEXT_BEARING_SOURCE_TYPES.includes(sourceType);
}

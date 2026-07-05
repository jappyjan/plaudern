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
 * Source types whose payload (when it is a text/* blob) is the content itself:
 * typed notes, web-clip snapshots, email bodies and plain-text file uploads.
 * Their content enters the extraction DAG via a passthrough "transcription"
 * row instead of a speech provider.
 */
export const TEXT_BEARING_SOURCE_TYPES: readonly SourceType[] = [
  'text',
  'web',
  'email',
  'file',
];

export function isTextBearing(sourceType: SourceType): boolean {
  return TEXT_BEARING_SOURCE_TYPES.includes(sourceType);
}

/**
 * Whether an item's payload is audio — either an audio-bearing source type or
 * an audio blob behind a generic source (e.g. an mp3 uploaded as a 'file').
 * The UI keys the player/transcript affordances off this, matching the
 * backend's transcription gate.
 */
export function hasAudioPayload(
  sourceType: SourceType,
  contentType?: string | null,
): boolean {
  return isAudioBearing(sourceType) || (contentType?.startsWith('audio/') ?? false);
}

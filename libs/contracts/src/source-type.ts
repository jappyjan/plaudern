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
  /**
   * A photo or scan of the physical world (paper mail, whiteboard, receipt,
   * business card, handwritten note) or an uploaded document (PDF). Its payload
   * is an image/* or application/pdf blob that flows into the OCR + docmeta
   * extraction pipeline (JJ-30/JJ-16) rather than transcription.
   */
  Image: 'image',
} as const;

export const sourceTypeSchema = z.enum([
  'audio',
  'text',
  'file',
  'plaud',
  'web',
  'email',
  'image',
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

/**
 * Content types whose payload is a document/image and therefore get OCR +
 * document-understanding (docmeta) on commit instead of transcription: photos,
 * scans and PDFs. Keyed off the content type (not just the `image` source type)
 * so a PDF uploaded as a generic `file` flows into the same pipeline (JJ-16).
 */
export function hasDocumentPayload(contentType?: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return ct.startsWith('image/') || ct === 'application/pdf';
}

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

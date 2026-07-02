import { z } from 'zod';
import { sourceTypeSchema } from './source-type';

/** Lifecycle of the raw blob behind an inbox item. */
export const uploadStatusSchema = z.enum(['pending', 'committed']);
export type UploadStatus = z.infer<typeof uploadStatusSchema>;

/** Lifecycle of a derived artifact (transcription, OCR, ...). */
export const extractionStatusSchema = z.enum([
  'queued',
  'processing',
  'succeeded',
  'failed',
]);
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;

export const extractionKindSchema = z.enum(['transcription', 'ocr', 'diarization']);
export type ExtractionKind = z.infer<typeof extractionKindSchema>;

/**
 * A timed slice of a derived artifact. Transcription rows carry `text`
 * (whisper verbose_json segments), diarization rows carry `speaker`
 * (per-recording labels like SPEAKER_00).
 */
export const extractionSegmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string().optional(),
  speaker: z.string().optional(),
});
export type ExtractionSegment = z.infer<typeof extractionSegmentSchema>;

/** The immutable raw payload pointer (1:1 with an inbox item). */
export const sourcePayloadSchema = z.object({
  id: z.string().uuid(),
  storageKey: z.string(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
  checksum: z.string().nullable(),
  originalFilename: z.string().nullable(),
  uploadStatus: uploadStatusSchema,
  createdAt: z.string().datetime(),
});
export type SourcePayloadDto = z.infer<typeof sourcePayloadSchema>;

/** An append-only derived artifact. Reprocessing creates a new row, never edits. */
export const extractedPayloadSchema = z.object({
  id: z.string().uuid(),
  kind: extractionKindSchema,
  provider: z.string(),
  status: extractionStatusSchema,
  content: z.string().nullable(),
  segments: z.array(extractionSegmentSchema).nullable(),
  language: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type ExtractedPayloadDto = z.infer<typeof extractedPayloadSchema>;

/** The immutable inbox envelope — the source of truth. Never edited or deleted. */
export const inboxItemSchema = z.object({
  id: z.string().uuid(),
  sourceType: sourceTypeSchema,
  occurredAt: z.string().datetime(),
  ingestedAt: z.string().datetime(),
  /** Free-form capture metadata (GPS location, recording device, file tags, ...). */
  metadata: z.record(z.string(), z.unknown()).nullable(),
  source: sourcePayloadSchema.nullable(),
  extractions: z.array(extractedPayloadSchema),
});
export type InboxItemDto = z.infer<typeof inboxItemSchema>;

export const inboxListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().uuid().optional(),
});
export type InboxListQuery = z.infer<typeof inboxListQuerySchema>;

export const inboxListResponseSchema = z.object({
  items: z.array(inboxItemSchema),
  nextCursor: z.string().uuid().nullable(),
});
export type InboxListResponse = z.infer<typeof inboxListResponseSchema>;

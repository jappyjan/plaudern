import { z } from 'zod';
import { sourceTypeSchema } from './source-type';
import { inboxItemSchema } from './inbox';

/**
 * Phase 1 of the two-phase presigned upload (plan §2/§3).
 * The client declares the blob it is about to upload; the server creates the
 * immutable envelope + a pending source payload and returns a presigned PUT URL.
 */
export const ingestInitRequestSchema = z.object({
  sourceType: sourceTypeSchema,
  contentType: z.string().min(1),
  byteSize: z.number().int().positive(),
  /** When the content was actually captured (e.g. device recording time). */
  occurredAt: z.string().datetime(),
  /** sha256 hex of the blob; optional for M1 (see plan §7). */
  checksum: z.string().optional(),
  originalFilename: z.string().optional(),
  /** Dedupe key so re-uploads are idempotent (e.g. plaud file id + device). */
  idempotencyKey: z.string().min(1),
  /** Free-form source metadata (e.g. plaud device serial, recording id). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type IngestInitRequest = z.infer<typeof ingestInitRequestSchema>;

export const ingestInitResponseSchema = z.object({
  inboxItemId: z.string().uuid(),
  storageKey: z.string(),
  /** Presigned S3/MinIO PUT URL the client uploads bytes to directly. */
  uploadUrl: z.string().url(),
  /** True when idempotencyKey matched an already-committed item (skip upload). */
  alreadyCommitted: z.boolean(),
});
export type IngestInitResponse = z.infer<typeof ingestInitResponseSchema>;

/** Inline text ingestion — no presigned upload needed. */
export const ingestTextRequestSchema = z.object({
  text: z.string().min(1),
  occurredAt: z.string().datetime(),
  idempotencyKey: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type IngestTextRequest = z.infer<typeof ingestTextRequestSchema>;

import { z } from 'zod';

/**
 * Contracts for the AI-provider audit log & data-sovereignty controls (JJ-42) —
 * the guardian layer over a life archive.
 *
 * The audit log records calls this instance makes to external AI providers:
 * which item it was for, which extraction/generation kind drove it, which
 * provider + endpoint, when, how many bytes were sent, and a content hash of the
 * payload. By default NO payload is stored — only metadata + size + a SHA-256
 * hash — so the audit trail can prove what left the box without itself becoming
 * a second copy of the user's private data. An operator opt-in
 * (`AI_AUDIT_STORE_PAYLOAD=true`) additionally stores a truncated (NOT
 * PII-scrubbed) copy of the request payload for debugging.
 *
 * Coverage: recording is emitted from the shared recorder at each provider
 * adapter. Wired today: transcription (ElevenLabs + self-hosted Whisper),
 * pyannoteAI diarization, the embeddings provider, and the OpenAI-compatible LLM
 * extractors/generators — summary, entities, relations, topics, topic-document,
 * facts, tasks, questions, decisions, commitments, reminders, journal, and
 * memory chat. Known deferred call sites (a follow-up ticket tracks full
 * coverage): the secondary entity contact-resolution LLM call, the entity
 * registry-correction LLM call, and the topic-proposals clustering call.
 * Geocoding (Nominatim) is deliberately OUT of scope — it is a maps lookup that
 * sends only coordinates, never transcript-derived content, and is not an AI
 * provider.
 */

/**
 * Direction of the audited transfer. Today every audited call is `outbound`
 * (bytes we sent to a provider); the enum leaves room to also record the size
 * of what came back without a schema change.
 */
export const aiProviderCallDirectionSchema = z.enum(['outbound', 'inbound']);
export type AiProviderCallDirection = z.infer<typeof aiProviderCallDirectionSchema>;

/**
 * One audited external AI-provider call. `kind` is the extraction/generation
 * kind that drove the call (transcription, diarization, summary, embedding, …)
 * — a free string rather than an enum so a new extractor is auditable the day it
 * ships, before this contract knows its name.
 */
export const aiProviderCallDtoSchema = z.object({
  id: z.string().uuid(),
  /** The inbox item the call was made for, when the call is item-scoped. */
  itemId: z.string().uuid().nullable(),
  /** Extraction/generation kind that drove the call (e.g. `summary`). */
  kind: z.string(),
  /** Provider id (e.g. `elevenlabs-scribe`, `pyannoteai`, `openai:deepseek-chat`). */
  provider: z.string(),
  /** The remote endpoint the bytes were sent to (host + path, no query/secrets). */
  endpoint: z.string(),
  direction: aiProviderCallDirectionSchema,
  /** Number of payload bytes sent to the provider. */
  bytesSent: z.number().int().nonnegative(),
  /** SHA-256 (hex) of the payload, so identical payloads are correlatable. */
  contentHash: z.string(),
  /** Whether a redacted payload copy is stored (operator opt-in). */
  hasPayload: z.boolean(),
  createdAt: z.string().datetime(),
});
export type AiProviderCallDto = z.infer<typeof aiProviderCallDtoSchema>;

/** Paginated query for a user's audit log (newest first). */
export const auditLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

export const auditLogListResponseSchema = z.object({
  entries: z.array(aiProviderCallDtoSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  hasMore: z.boolean(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

/**
 * Panic-delete: an irreversible wipe of the signed-in user's archive. Guarded by
 * an explicit confirmation phrase in the body so it can never be triggered by a
 * stray click or a replayed request.
 */
export const PANIC_DELETE_CONFIRMATION = 'DELETE MY DATA';
export const panicDeleteRequestSchema = z.object({
  confirm: z.literal(PANIC_DELETE_CONFIRMATION),
});
export type PanicDeleteRequest = z.infer<typeof panicDeleteRequestSchema>;

export const panicDeleteResponseSchema = z.object({
  deletedItems: z.number().int().nonnegative(),
  deletedAuditEntries: z.number().int().nonnegative(),
});
export type PanicDeleteResponse = z.infer<typeof panicDeleteResponseSchema>;

/**
 * Legacy / emergency-access ("dead-man's switch"): a life archive needs an
 * answer for incapacity. This is a MINIMAL scaffold (JJ-42) — it persists a
 * trusted contact, a check-in interval, and the last check-in — so the data
 * model and the check-in ritual exist. The actual release mechanism (notifying
 * the contact and granting access when a check-in is missed) is deferred to a
 * follow-up; `triggersAt` is computed for display only and nothing fires yet.
 */
export const deadMansSwitchSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  /** Email of the trusted contact who would be reached on incapacity. */
  contactEmail: z.string().email().nullable(),
  /** Days without a check-in before the switch is considered tripped. */
  checkInIntervalDays: z.number().int().min(1),
  lastCheckInAt: z.string().datetime().nullable(),
  /** lastCheckInAt + interval, for display; null until first check-in. */
  triggersAt: z.string().datetime().nullable(),
});
export type DeadMansSwitchDto = z.infer<typeof deadMansSwitchSchema>;

export const updateDeadMansSwitchRequestSchema = z.object({
  enabled: z.boolean(),
  contactEmail: z.string().email().nullable(),
  checkInIntervalDays: z.number().int().min(1).max(3650),
});
export type UpdateDeadMansSwitchRequest = z.infer<typeof updateDeadMansSwitchRequestSchema>;

/**
 * Shape of the export-everything bundle (JJ-42): a single self-describing JSON
 * document with the user's items, their extractions, and presigned asset URLs,
 * plus a combined Markdown rendering. Delivered as a downloadable attachment;
 * the web client saves it verbatim rather than parsing it, so this type is a
 * reference for consumers rather than a strict runtime gate.
 */
export interface AccountExportAsset {
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  /** Presigned GET URL into storage; time-limited. Null if the blob is gone. */
  downloadUrl: string | null;
}
export interface AccountExportExtraction {
  id: string;
  kind: string;
  version: number;
  provider: string;
  status: string;
  content: string | null;
  language: string | null;
  createdAt: string;
  completedAt: string | null;
}
export interface AccountExportItem {
  id: string;
  sourceType: string;
  occurredAt: string;
  ingestedAt: string;
  metadata: Record<string, unknown> | null;
  source: AccountExportAsset | null;
  extractions: AccountExportExtraction[];
}
export interface AccountExport {
  schemaVersion: 1;
  exportedAt: string;
  userId: string;
  itemCount: number;
  items: AccountExportItem[];
  /** A combined, human-readable Markdown rendering of the whole archive. */
  markdown: string;
}

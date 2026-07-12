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
 * memory chat. Also wired (JJ-81): `docmeta` document-metadata extraction, the
 * `ocr` vision OCR call (which auto-enables from the OpenAI embeddings key, so
 * it is a live path), the `sensitivity` sentinel classifier, the `citations`
 * LLM-judge verification pass, the secondary entity contact-resolution call, the
 * entity judge that drives duplicate reconciliation, and topic-proposals cluster
 * labeling. The sole remaining deferred site is the opt-in `web_research` entity
 * call, which only runs when a user explicitly enables it. Geocoding (Nominatim)
 * is deliberately OUT of scope — it is a maps lookup that sends only
 * coordinates, never transcript-derived content, and is not an AI provider.
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
 * A dead-man's-switch RELEASE (JJ-80): an actual firing of the switch and the
 * scoped emergency grant it produced. Surfaced to the OWNER so they can see (and
 * revoke) any access their switch has handed out. The token itself is never
 * exposed here — only the lifecycle status.
 */
export const deadMansSwitchReleaseStatusSchema = z.enum([
  'pending',
  'active',
  'cancelled',
  'revoked',
]);
export type DeadMansSwitchReleaseStatus = z.infer<typeof deadMansSwitchReleaseStatusSchema>;

export const deadMansSwitchReleaseSchema = z.object({
  id: z.string().uuid(),
  contactEmail: z.string().email(),
  status: deadMansSwitchReleaseStatusSchema,
  /** When the check-in lapsed and the grace/confirmation window opened. */
  firedAt: z.string().datetime(),
  /** Access is only granted once this instant passes. */
  graceUntil: z.string().datetime(),
  /** When the contact was actually granted access; null while pending. */
  grantedAt: z.string().datetime().nullable(),
  /** When the release was revoked or cancelled; null while live. */
  closedAt: z.string().datetime().nullable(),
});
export type DeadMansSwitchReleaseDto = z.infer<typeof deadMansSwitchReleaseSchema>;

export const deadMansSwitchReleasesResponseSchema = z.object({
  releases: z.array(deadMansSwitchReleaseSchema),
});
export type DeadMansSwitchReleasesResponse = z.infer<
  typeof deadMansSwitchReleasesResponseSchema
>;

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
/**
 * One question row in the export. Included because questions carry USER-AUTHORED
 * state that no recording or re-extraction can regenerate: the settled status
 * and — since the MCP `answer_question` tool — the recorded `answer` text.
 */
export interface AccountExportQuestion {
  id: string;
  inboxItemId: string;
  direction: string;
  counterpartyName: string;
  question: string;
  status: string;
  /** The recorded answer text; null when resolved without recorded text. */
  answer: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface AccountExport {
  schemaVersion: 1;
  exportedAt: string;
  userId: string;
  itemCount: number;
  items: AccountExportItem[];
  /** The user's questions, including user-authored answers/statuses. */
  questions: AccountExportQuestion[];
  /** A combined, human-readable Markdown rendering of the whole archive. */
  markdown: string;
}

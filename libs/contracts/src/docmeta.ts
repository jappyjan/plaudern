import { z } from 'zod';
import { extractionStatusSchema } from './inbox';

/**
 * Contracts for the `docmeta` extraction kind (JJ-30 photo/scan understanding +
 * JJ-16 document vault). After `ocr` recognizes a scanned image or PDF's text,
 * an LLM classifies the document and pulls its key fields. Each item gets at
 * most ONE docmeta row (upserted by inboxItemId on re-extraction), which powers:
 *   - the document vault view (grouped by type, expiry/Kündigungsfrist surfaced),
 *   - deadline reminders (expiry + cancellation dates → prospective reminders),
 *   - business-card contact enrichment (name/org → the entity registry).
 *
 * `docmeta` reads the OCR TEXT (not the image), so it can run on the cheap
 * text-tier model even when only OCR needs vision.
 */

/**
 * The kind of document. `other` is the catch-all. `business_card` triggers
 * contact enrichment; `contract`/`insurance`/`warranty` are the vault's
 * deadline-bearing types (expiry + Kündigungsfrist).
 */
export const documentTypeSchema = z.enum([
  'invoice',
  'receipt',
  'contract',
  'insurance',
  'warranty',
  'letter',
  'prescription',
  'id_document',
  'bank_statement',
  'payslip',
  'business_card',
  'other',
]);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/** One extracted key/value fact from the document (e.g. "Invoice no." → "R-2024-0192"). */
export const docMetaFieldSchema = z.object({
  label: z.string().min(1),
  value: z.string().min(1),
});
export type DocMetaField = z.infer<typeof docMetaFieldSchema>;

/**
 * Contact details lifted from a business card (JJ-30). Present only when the
 * document type is `business_card`. The name/organization seed the entity
 * registry; the rest are surfaced on the vault card.
 */
export const docMetaContactSchema = z.object({
  fullName: z.string().nullable().default(null),
  organization: z.string().nullable().default(null),
  jobTitle: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
});
export type DocMetaContact = z.infer<typeof docMetaContactSchema>;

/**
 * One document's metadata as produced by the LLM, before persistence. Dates may
 * be absolute ISO (YYYY-MM-DD) or a raw phrase — the server resolves them
 * against the capture time for reminders (mirroring the reminders extractor).
 */
export const extractedDocMetaSchema = z.object({
  documentType: documentTypeSchema,
  /** A short human title for the document ("Vodafone mobile contract"). */
  title: z.string().min(1),
  /** A one-line summary of what the document is / says, or null. */
  summary: z.string().nullable().default(null),
  /** Who the document is from (company, authority, sender), or null. */
  issuer: z.string().nullable().default(null),
  /** Key facts as label/value pairs. */
  fields: z.array(docMetaFieldSchema).default([]),
  /** Monetary amount on the document (invoice total, contract fee), or null. */
  amount: z.number().nullable().default(null),
  /** ISO-4217 currency of `amount` (e.g. "EUR"), or null. */
  currency: z.string().nullable().default(null),
  /** An IBAN found on the document (for invoices/bank statements), or null. */
  iban: z.string().nullable().default(null),
  /** When the document / entitlement expires — ISO date or phrase, or null. */
  expiryDate: z.string().nullable().default(null),
  /**
   * The last day to cancel (Kündigungsfrist deadline) — ISO date or phrase, or
   * null. German-bureaucracy cancellation windows the vault must never miss.
   */
  cancellationDate: z.string().nullable().default(null),
  /** Business-card contact details; null unless documentType is business_card. */
  contact: docMetaContactSchema.nullable().default(null),
  /** The model's overall confidence in the classification/fields (0..1), or null. */
  confidence: z.number().min(0).max(1).nullable().default(null),
});
export type ExtractedDocMeta = z.infer<typeof extractedDocMetaSchema>;

/**
 * The persisted shape of a `docmeta` extraction's `content` (provenance on the
 * append-only extracted_payloads row). The structured document lives in the
 * `document_metadata` table.
 */
export const docMetaExtractionPayloadSchema = z.object({
  model: z.string(),
  documentType: documentTypeSchema,
  /** How many deadline reminders this docmeta produced. */
  reminderCount: z.number().int().nonnegative(),
  /** Whether a contact was created/enriched from a business card. */
  contactEnriched: z.boolean(),
});
export type DocMetaExtractionPayload = z.infer<typeof docMetaExtractionPayloadSchema>;

/** A persisted document as returned by the API (vault card + item read model). */
export const documentSchema = z.object({
  id: z.string().uuid(),
  inboxItemId: z.string().uuid(),
  documentType: documentTypeSchema,
  title: z.string(),
  summary: z.string().nullable(),
  issuer: z.string().nullable(),
  fields: z.array(docMetaFieldSchema),
  amount: z.number().nullable(),
  currency: z.string().nullable(),
  iban: z.string().nullable(),
  /** Resolved absolute ISO date when parseable, else the raw phrase, or null. */
  expiryDate: z.string().nullable(),
  /** Resolved absolute ISO date when parseable, else the raw phrase, or null. */
  cancellationDate: z.string().nullable(),
  contact: docMetaContactSchema.nullable(),
  confidence: z.number().nullable(),
  /** When the source document was captured/scanned. */
  occurredAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type DocumentDto = z.infer<typeof documentSchema>;

/**
 * Read model for an item's docmeta tab: the latest extraction's status plus the
 * structured document (null until docmeta lands).
 */
export const itemDocMetaResponseSchema = z.object({
  status: extractionStatusSchema.nullable(),
  document: documentSchema.nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
});
export type ItemDocMetaResponse = z.infer<typeof itemDocMetaResponseSchema>;

/** Optional filter for the vault list: scope to a single document type. */
export const documentListQuerySchema = z.object({
  documentType: documentTypeSchema.optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

/** The vault list response: every document the user has, newest first. */
export const documentListResponseSchema = z.object({
  documents: z.array(documentSchema),
});
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  ExtractedDocMeta,
  ExtractedEntity,
  ExtractedReminder,
} from '@plaudern/contracts';
import { DocumentMetadataEntity } from '@plaudern/persistence';
import { RemindersPersistenceService } from '@plaudern/reminders';
import { EntitiesRegistryService } from '@plaudern/entities';
import { resolveDocumentDate } from './document-date';

/** Caps so adversarial/verbose model output can't store huge strings. */
const MAX_TITLE_CHARS = 500;
const MAX_TEXT_CHARS = 2_000;
const MAX_FIELD_CHARS = 500;
const MAX_FIELDS = 40;

/** Human labels for reminder titles, per document type. */
const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  contract: 'Contract',
  insurance: 'Insurance policy',
  warranty: 'Warranty',
  letter: 'Letter',
  prescription: 'Prescription',
  id_document: 'ID document',
  bank_statement: 'Bank statement',
  payslip: 'Payslip',
  business_card: 'Business card',
  other: 'Document',
};

export interface DocMetaPersistResult {
  reminderCount: number;
  contactEnriched: boolean;
}

/**
 * Persists one docmeta extraction's output (JJ-30/JJ-16). It:
 *   1. upserts the ONE `document_metadata` row for the item (by inboxItemId),
 *      repointing `extractionId` and refreshing every field on re-extraction —
 *      a concurrent re-OCR racing the insert loses the unique index and is
 *      retried as an update against the winner's row (JJ-84, mirroring
 *      RemindersPersistenceService), so two workers processing the same item
 *      converge on a single row instead of one erroring out,
 *   2. turns the expiry + Kündigungsfrist dates into prospective reminders via
 *      the JJ-25 reminders infra (which resolves dates against the scan time,
 *      dedups/upserts, and — crucially — NEVER clobbers a user-dismissed
 *      reminder on re-extraction),
 *   3. for a business card, creates/enriches a contact in the entity registry
 *      via the existing evidence-based resolver (dedup by name, idempotent).
 *
 * Lives in its OWN provider (not DocMetaService) so the dependency graph stays
 * acyclic: DocMetaService → DOCMETA_QUEUE → DocMetaProcessor →
 * DocMetaPersistenceService, with no edge back to the service.
 */
@Injectable()
export class DocMetaPersistenceService {
  private readonly logger = new Logger(DocMetaPersistenceService.name);

  constructor(
    @InjectRepository(DocumentMetadataEntity)
    private readonly documents: Repository<DocumentMetadataEntity>,
    private readonly reminders: RemindersPersistenceService,
    private readonly registry: EntitiesRegistryService,
  ) {}

  /**
   * Persist a docmeta result for an item. Returns how many deadline reminders
   * were produced and whether a business-card contact was enriched.
   */
  async persist(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    occurredAt: string,
    docMeta: ExtractedDocMeta,
  ): Promise<DocMetaPersistResult> {
    const expiryDate = clampOrNull(docMeta.expiryDate, MAX_FIELD_CHARS);
    const cancellationDate = clampOrNull(docMeta.cancellationDate, MAX_FIELD_CHARS);
    // The document's own date, resolved to an absolute ISO datetime against the
    // scan time. Stored only when it parses (it becomes the item's displayed
    // date); an unparseable/absent date leaves the capture time in place.
    const documentDate = resolveDocumentDate(docMeta.documentDate, occurredAt);

    const fields = (docMeta.fields ?? [])
      .slice(0, MAX_FIELDS)
      .map((f) => ({
        label: clamp(f.label, MAX_FIELD_CHARS),
        value: clamp(f.value, MAX_FIELD_CHARS),
      }))
      .filter((f) => f.label && f.value);

    const contact = docMeta.documentType === 'business_card' ? docMeta.contact : null;

    // 1) Upsert the single document_metadata row (one per item).
    const rowFields = {
      userId,
      inboxItemId,
      extractionId,
      documentType: docMeta.documentType,
      title: clamp(docMeta.title, MAX_TITLE_CHARS) || TYPE_LABELS[docMeta.documentType] || 'Document',
      summary: clampOrNull(docMeta.summary, MAX_TEXT_CHARS),
      issuer: clampOrNull(docMeta.issuer, MAX_TEXT_CHARS),
      fields: fields.length > 0 ? fields : null,
      amount: docMeta.amount ?? null,
      currency: clampOrNull(docMeta.currency, 8),
      iban: clampOrNull(docMeta.iban, 64),
      documentDate,
      expiryDate,
      cancellationDate,
      contact: contact ?? null,
      confidence: docMeta.confidence ?? null,
    };
    const existing = await this.documents.findOne({ where: { inboxItemId } });
    if (existing) {
      Object.assign(existing, rowFields);
      await this.documents.save(existing);
    } else {
      try {
        await this.documents.save(this.documents.create(rowFields));
      } catch (err) {
        // Lost a race on the unique index (concurrent re-OCR of the same item) —
        // re-read the winner and update it instead of failing. Mirrors
        // RemindersPersistenceService's exact retry pattern.
        if (!isUniqueViolation(err)) throw err;
        const winner = await this.documents.findOne({ where: { inboxItemId } });
        if (!winner) throw err;
        Object.assign(winner, rowFields);
        await this.documents.save(winner);
      }
    }

    // 2) Deadline reminders from expiry + Kündigungsfrist. The reminders infra
    // resolves each date against the scan time, drops past/unparseable ones,
    // and preserves user-dismissed rows across re-extraction.
    const label = TYPE_LABELS[docMeta.documentType] ?? 'Document';
    const subject = docMeta.issuer ? `${label} — ${docMeta.issuer}` : label;
    const extractedReminders: ExtractedReminder[] = [];
    if (expiryDate) {
      extractedReminders.push({
        title: `${subject} expires`,
        dueDate: expiryDate,
        confidence: docMeta.confidence ?? null,
        sourceQuote: docMeta.title,
        sourceTimestamp: null,
      });
    }
    if (cancellationDate) {
      extractedReminders.push({
        title: `Cancellation deadline (Kündigungsfrist): ${subject}`,
        dueDate: cancellationDate,
        confidence: docMeta.confidence ?? null,
        sourceQuote: docMeta.title,
        sourceTimestamp: null,
      });
    }
    let reminderCount = 0;
    if (extractedReminders.length > 0) {
      reminderCount = await this.reminders.persist(
        userId,
        inboxItemId,
        extractionId,
        occurredAt,
        extractedReminders,
      );
    }

    // 3) Business-card → contact enrichment via the existing entity registry.
    let contactEnriched = false;
    if (contact) {
      try {
        contactEnriched = await this.enrichContact(userId, inboxItemId, extractionId, contact);
      } catch (err) {
        // Never fail the extraction over contact enrichment (best-effort).
        this.logger.warn(
          `contact enrichment failed for item ${inboxItemId}: ${(err as Error).message}`,
        );
      }
    }

    return { reminderCount, contactEnriched };
  }

  /**
   * Create/enrich a contact from a business card, reusing the evidence-based
   * registry resolver (dedup by name, alias accretion, idempotent). The person's
   * name becomes a `person` entity and the organization (if any) an
   * `organization` entity, both mentioned by this scan — so the physical card
   * becomes a searchable registry contact.
   */
  private async enrichContact(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    contact: NonNullable<ExtractedDocMeta['contact']>,
  ): Promise<boolean> {
    const name = contact.fullName?.trim();
    if (!name) return false;
    const entities: ExtractedEntity[] = [
      { type: 'person', name, mentions: [name] },
    ];
    const org = contact.organization?.trim();
    if (org) entities.push({ type: 'organization', name: org, mentions: [org] });
    const touched = await this.registry.ingest(userId, inboxItemId, extractionId, entities);
    return touched > 0;
  }
}

/** Trim + hard-cap a model-supplied string so stored values stay bounded. */
function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function clampOrNull(value: string | null | undefined, maxChars: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = clamp(value, maxChars);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505, better-sqlite3 a SQLITE_CONSTRAINT* code /
 * "UNIQUE constraint failed" message. Anything else must propagate. Mirrors
 * RemindersPersistenceService's helper.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

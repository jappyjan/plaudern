import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { DocMetaContact, DocMetaField, DocumentType } from '@plaudern/contracts';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * Structured metadata for one scanned/uploaded document (JJ-30 photo/scan
 * understanding + JJ-16 vault). Produced by the `docmeta` extractor from an
 * item's OCR text: the document type, key fields, monetary/IBAN details, and
 * the expiry + Kündigungsfrist (cancellation) dates that become deadline
 * reminders. Powers the vault view (grouped by `documentType`).
 *
 * ONE row per inbox item — unique on `inboxItemId` — so re-OCR of the same
 * document upserts onto the same row instead of duplicating (`extractionId` is
 * repointed to the latest generation for provenance). Extraction-owned: the
 * whole row is refreshed on re-extraction (the user-owned durability lives on
 * the derived reminders, not here). Lives OUTSIDE the immutable inbox aggregate,
 * like a reminder or a registry entity.
 */
@Entity({ name: 'document_metadata' })
@Index(['userId'])
@Index(['userId', 'documentType'])
@Index(['inboxItemId'], { unique: true })
export class DocumentMetadataEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  /** The `docmeta` extraction generation that last produced this row. */
  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  @Column({ type: 'varchar' })
  documentType!: DocumentType;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  @Column({ type: 'text', nullable: true })
  issuer!: string | null;

  /** Key facts as label/value pairs. */
  @Column({ type: 'simple-json', nullable: true })
  fields!: DocMetaField[] | null;

  @Column({ type: 'float', nullable: true })
  amount!: number | null;

  @Column({ type: 'varchar', nullable: true })
  currency!: string | null;

  @Column({ type: 'varchar', nullable: true })
  iban!: string | null;

  /** Resolved absolute ISO date when parseable, else the raw phrase, or null. */
  @Column({ type: 'varchar', nullable: true })
  expiryDate!: string | null;

  /** The Kündigungsfrist cancellation deadline (ISO or phrase), or null. */
  @Column({ type: 'varchar', nullable: true })
  cancellationDate!: string | null;

  /** Business-card contact details; null unless documentType is business_card. */
  @Column({ type: 'simple-json', nullable: true })
  contact!: DocMetaContact | null;

  @Column({ type: 'float', nullable: true })
  confidence!: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

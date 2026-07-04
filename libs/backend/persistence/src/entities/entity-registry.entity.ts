import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { EntityType } from '@plaudern/contracts';

/**
 * A normalized entity in the per-user registry (JJ-32) — a person, place,
 * organization, medication, … pulled from recordings by the `entities`
 * extractor. This is the seed of the knowledge graph: `entity_mentions` link
 * these rows to the recordings they appear in, and `person` rows link to the
 * voice-profile contact book via `voiceProfileId`.
 *
 * Mutable by design (aliases accrete, the person link resolves later), so it
 * lives OUTSIDE the immutable inbox aggregate — exactly like a voice profile.
 * Dedupe key is (userId, type, normalizedName): the lowercased canonical name,
 * so "Angela Merkel" and "angela merkel" collapse into one row.
 */
@Entity({ name: 'entities' })
@Index(['userId'])
@Index(['userId', 'type', 'normalizedName'], { unique: true })
export class EntityRegistryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  type!: EntityType;

  /** Display/canonical name as first seen (or the longest variant seen). */
  @Column({ type: 'varchar' })
  canonicalName!: string;

  /** Lowercased canonical name — the dedupe/normalization key. */
  @Column({ type: 'varchar' })
  normalizedName!: string;

  /** Known surface forms/spellings collapsed into this entity. */
  @Column({ type: 'simple-json' })
  aliases!: string[];

  /**
   * Linked voice-profile id when this `person` matches a contact in the
   * speaker-id contact book; null otherwise (and always null for non-people).
   * A loose reference (no FK) so the registry stays decoupled from speaker-id,
   * mirroring how embedding chunks carry a bare `userId`.
   */
  @Column({ type: 'uuid', nullable: true })
  voiceProfileId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

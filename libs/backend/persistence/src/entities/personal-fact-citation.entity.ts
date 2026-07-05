import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InboxItemEntity } from './inbox-item.entity';
import { ExtractedPayloadEntity } from './extracted-payload.entity';
import { PersonalFactEntity } from './personal-fact.entity';

/**
 * One appearance of a personal fact in one recording (JJ-31) — the edge that
 * turns "three recordings mention the allergy" into one fact with three
 * citations. Keyed to the `facts` extraction row that produced it, so
 * append-only reprocessing yields a fresh set of citations per extraction; the
 * facts registry counts only the LATEST succeeded extraction per item, exactly
 * like task citations and entity mentions.
 *
 * The unique (extractionId, factId) index makes ingestion idempotent: a re-run
 * or backfill of the same extraction can never double-cite a fact.
 */
@Entity({ name: 'personal_fact_citations' })
@Index(['inboxItemId'])
@Index(['factId'])
@Index(['extractionId', 'factId'], { unique: true })
export class PersonalFactCitationEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => PersonalFactEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'factId' })
  fact!: PersonalFactEntity;

  @Column({ type: 'uuid' })
  factId!: string;

  @ManyToOne(() => InboxItemEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid' })
  inboxItemId!: string;

  @ManyToOne(() => ExtractedPayloadEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'extractionId' })
  extraction!: ExtractedPayloadEntity;

  @Column({ type: 'uuid' })
  extractionId!: string;

  /** Denormalized owner for per-user scoping and purge. */
  @Column({ type: 'uuid' })
  userId!: string;

  /** The sentence this recording stated the fact in; null if not captured. */
  @Column({ type: 'text', nullable: true })
  quote!: string | null;

  /** Segment start (seconds) into the recording when the quote was located. */
  @Column({ type: 'float', nullable: true })
  startSeconds!: number | null;

  @CreateDateColumn()
  createdAt!: Date;
}

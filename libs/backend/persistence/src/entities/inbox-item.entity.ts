import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { SourceType } from '@plaudern/contracts';
import { SourcePayloadEntity } from './source-payload.entity';
import { ExtractedPayloadEntity } from './extracted-payload.entity';

/**
 * The inbox envelope — the source of truth. Rows are never edited in place:
 * there is deliberately NO updatedAt. Items can only be deleted whole (with
 * their source and extractions), leaving a row in inbox_tombstones so
 * automated syncs don't re-import them. Derived data lives in append-only
 * extracted_payloads.
 */
@Entity({ name: 'inbox_items' })
@Index(['userId', 'ingestedAt'])
@Index(['userId', 'idempotencyKey'], { unique: true })
export class InboxItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'uuid', nullable: true })
  deviceId!: string | null;

  @Column({ type: 'varchar' })
  sourceType!: SourceType;

  /** When the content was captured (device recording time). ISO 8601 UTC. */
  @Column({ type: 'varchar' })
  occurredAt!: string;

  @CreateDateColumn()
  ingestedAt!: Date;

  /** Dedupe key, unique per owning user, making re-ingestion idempotent. */
  @Column({ type: 'varchar' })
  idempotencyKey!: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata!: Record<string, unknown> | null;

  @OneToOne(() => SourcePayloadEntity, (payload) => payload.inboxItem, {
    cascade: true,
  })
  source!: SourcePayloadEntity | null;

  @OneToMany(() => ExtractedPayloadEntity, (extracted) => extracted.inboxItem)
  extractions!: ExtractedPayloadEntity[];
}

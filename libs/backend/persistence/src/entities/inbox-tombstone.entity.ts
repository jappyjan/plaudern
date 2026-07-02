import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { SourceType } from '@plaudern/contracts';

/**
 * Records the idempotency key of a deleted inbox item so automated re-ingest
 * (Plaud cloud sync) never resurrects it. Manual ingestion deliberately does
 * NOT consult tombstones — re-uploading the same content after a delete is a
 * legitimate user action.
 */
@Entity({ name: 'inbox_tombstones' })
export class InboxTombstoneEntity {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @PrimaryColumn({ type: 'varchar' })
  idempotencyKey!: string;

  @Column({ type: 'uuid' })
  deletedItemId!: string;

  @Column({ type: 'varchar' })
  sourceType!: SourceType;

  @CreateDateColumn()
  deletedAt!: Date;
}

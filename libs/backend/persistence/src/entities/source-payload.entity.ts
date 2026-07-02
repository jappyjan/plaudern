import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { UploadStatus } from '@plaudern/contracts';
import { InboxItemEntity } from './inbox-item.entity';

/**
 * The raw source blob pointer (1:1 with an inbox item). The object itself
 * lives in S3/MinIO at `storageKey`, is written exactly once, and is deleted
 * only together with its item.
 */
@Entity({ name: 'source_payloads' })
export class SourcePayloadEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @OneToOne(() => InboxItemEntity, (item) => item.source, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'inboxItemId' })
  inboxItem!: InboxItemEntity;

  @Column({ type: 'uuid', unique: true })
  inboxItemId!: string;

  @Column({ type: 'varchar' })
  storageKey!: string;

  @Column({ type: 'varchar' })
  contentType!: string;

  @Column({
    type: 'bigint',
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | number | null) => (value === null ? 0 : Number(value)),
    },
  })
  byteSize!: number;

  @Column({ type: 'varchar', nullable: true })
  checksum!: string | null;

  @Column({ type: 'varchar', nullable: true })
  originalFilename!: string | null;

  /** `pending` until the direct upload is confirmed at commit. */
  @Column({ type: 'varchar', default: 'pending' })
  uploadStatus!: UploadStatus;

  @CreateDateColumn()
  createdAt!: Date;
}

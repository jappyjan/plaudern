import { Column, CreateDateColumn, Entity, Index, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { UserEntity } from './user.entity';

export type DeviceKind = 'plaud' | 'generic';

/**
 * A registered client that can push to the inbox. `generic` covers direct
 * text/audio/file uploads and the dev upload screen; `plaud` is a paired device.
 * Authenticated by an API key (only the hash is stored).
 */
@Entity({ name: 'devices' })
export class DeviceEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => UserEntity, (user) => user.devices, { onDelete: 'CASCADE' })
  user!: UserEntity;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', default: 'generic' })
  kind!: DeviceKind;

  /** External identity for the device, e.g. a Plaud device serial. */
  @Column({ type: 'varchar', nullable: true })
  externalRef!: string | null;

  @Index({ unique: true })
  @Column({ type: 'varchar' })
  apiKeyHash!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

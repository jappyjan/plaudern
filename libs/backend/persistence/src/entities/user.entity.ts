import { Column, CreateDateColumn, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { DeviceEntity } from './device.entity';

@Entity({ name: 'users' })
export class UserEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', unique: true })
  email!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @OneToMany(() => DeviceEntity, (device) => device.user)
  devices!: DeviceEntity[];
}

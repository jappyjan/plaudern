import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DeviceEntity, DeviceKind, UserEntity } from '@plaudern/persistence';

export interface RegisteredDevice {
  device: DeviceEntity;
  /** Plaintext API key — returned once at registration, never stored. */
  apiKey: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
  ) {}

  static hashApiKey(apiKey: string): string {
    return createHash('sha256').update(apiKey).digest('hex');
  }

  static generateApiKey(): string {
    return `pk_${randomBytes(24).toString('hex')}`;
  }

  async ensureUser(email: string): Promise<UserEntity> {
    const existing = await this.users.findOne({ where: { email } });
    if (existing) return existing;
    return this.users.save(this.users.create({ email }));
  }

  async registerDevice(
    userId: string,
    kind: DeviceKind,
    externalRef?: string | null,
  ): Promise<RegisteredDevice> {
    const apiKey = AuthService.generateApiKey();
    const device = await this.devices.save(
      this.devices.create({
        userId,
        kind,
        externalRef: externalRef ?? null,
        apiKeyHash: AuthService.hashApiKey(apiKey),
      }),
    );
    return { device, apiKey };
  }

  async hasDevices(userId: string): Promise<boolean> {
    return (await this.devices.count({ where: { userId } })) > 0;
  }

  async findDeviceByApiKey(apiKey: string): Promise<DeviceEntity | null> {
    return this.devices.findOne({
      where: { apiKeyHash: AuthService.hashApiKey(apiKey) },
    });
  }
}

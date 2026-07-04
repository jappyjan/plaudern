import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  PlaudSettingsDto,
  PlaudSyncStatus,
  UpdatePlaudSettingsRequest,
} from '@plaudern/contracts';
import { PlaudSettingsEntity } from '@plaudern/persistence';
import { decryptSecret, encryptSecret } from '@plaudern/persistence';

/** Owns the Plaud settings rows — exactly one per user. */
@Injectable()
export class PlaudSettingsService {
  constructor(
    @InjectRepository(PlaudSettingsEntity)
    private readonly repo: Repository<PlaudSettingsEntity>,
    private readonly config: ConfigService,
  ) {}

  getEntity(userId: string): Promise<PlaudSettingsEntity | null> {
    return this.repo.findOne({ where: { userId } });
  }

  /** Every user's enabled settings — the sync scheduler's work list. */
  listEnabled(): Promise<PlaudSettingsEntity[]> {
    return this.repo.find({ where: { enabled: true }, order: { createdAt: 'ASC' } });
  }

  toDto(entity: PlaudSettingsEntity | null, syncRunning: boolean): PlaudSettingsDto {
    if (!entity) {
      return {
        configured: false,
        enabled: false,
        email: null,
        region: null,
        hasPassword: false,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
        lastSyncImportedCount: null,
        syncRunning,
      };
    }
    return {
      configured: true,
      enabled: entity.enabled,
      email: entity.email,
      region: entity.region,
      hasPassword: entity.passwordEncrypted.length > 0,
      lastSyncAt: entity.lastSyncAt,
      lastSyncStatus: entity.lastSyncStatus,
      lastSyncError: entity.lastSyncError,
      lastSyncImportedCount: entity.lastSyncImportedCount,
      syncRunning,
    };
  }

  async upsert(userId: string, req: UpdatePlaudSettingsRequest): Promise<PlaudSettingsEntity> {
    const secret = this.requireSecret();
    const existing = await this.getEntity(userId);

    if (!existing) {
      if (!req.password) {
        throw new BadRequestException('password is required when configuring Plaud credentials');
      }
      const created = this.repo.create({
        userId,
        email: req.email,
        passwordEncrypted: encryptSecret(req.password, secret),
        region: req.region,
        enabled: req.enabled,
      });
      return this.repo.save(created);
    }

    const credentialsChanged =
      existing.email !== req.email || existing.region !== req.region || Boolean(req.password);

    existing.email = req.email;
    existing.region = req.region;
    existing.enabled = req.enabled;
    if (req.password) {
      existing.passwordEncrypted = encryptSecret(req.password, secret);
    }
    if (credentialsChanged) {
      existing.accessToken = null;
      existing.accessTokenExpiresAt = null;
    }
    return this.repo.save(existing);
  }

  getDecryptedPassword(entity: PlaudSettingsEntity): string {
    try {
      return decryptSecret(entity.passwordEncrypted, this.requireSecret());
    } catch {
      throw new Error(
        'stored Plaud password cannot be decrypted (APP_ENCRYPTION_SECRET missing or changed) — re-enter the password in settings',
      );
    }
  }

  async saveToken(id: string, accessToken: string, expiresAt: string): Promise<void> {
    await this.repo.update({ id }, { accessToken, accessTokenExpiresAt: expiresAt });
  }

  async recordSyncResult(
    id: string,
    result: { status: PlaudSyncStatus; error?: string | null; importedCount?: number | null },
  ): Promise<void> {
    await this.repo.update(
      { id },
      {
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: result.status,
        lastSyncError: result.error ?? null,
        lastSyncImportedCount: result.importedCount ?? null,
      },
    );
  }

  private requireSecret(): string {
    const secret = this.config.get<string>('APP_ENCRYPTION_SECRET', '');
    if (!secret) {
      throw new BadRequestException(
        'APP_ENCRYPTION_SECRET is not configured on the server — set it to enable Plaud credential storage',
      );
    }
    return secret;
  }
}

import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EmailSettingsDto } from '@plaudern/contracts';
import { decryptSecret, EmailSettingsEntity, encryptSecret } from '@plaudern/persistence';

/** Local part before the `+<token>`, mirroring the plan's `inbox+<token>@<domain>`. */
const ADDRESS_TAG = 'inbox';

/**
 * Owns the email-in settings rows — exactly one per user (mirrors
 * PlaudSettingsService). The token is generated once and only changes on an
 * explicit rotate, at which point the old address stops working immediately
 * (no grace period — same as rotating any other credential).
 */
@Injectable()
export class EmailSettingsService {
  constructor(
    @InjectRepository(EmailSettingsEntity)
    private readonly repo: Repository<EmailSettingsEntity>,
    private readonly config: ConfigService,
  ) {}

  getEntity(userId: string): Promise<EmailSettingsEntity | null> {
    return this.repo.findOne({ where: { userId } });
  }

  toDto(entity: EmailSettingsEntity | null): EmailSettingsDto {
    if (!entity) {
      return { configured: false, enabled: false, address: null };
    }
    return {
      configured: true,
      enabled: entity.enabled,
      address: this.addressFor(entity),
    };
  }

  /** Reconstruct the full inbound address by decrypting the stored token. */
  private addressFor(entity: EmailSettingsEntity): string | null {
    const domain = this.config.get<string>('EMAIL_INBOUND_DOMAIN', '');
    if (!domain) return null;
    const token = decryptSecret(entity.tokenEncrypted, this.requireSecret());
    return `${ADDRESS_TAG}+${token}@${domain}`;
  }

  async setEnabled(userId: string, enabled: boolean): Promise<EmailSettingsEntity> {
    const existing = await this.getEntity(userId);
    if (!existing) {
      throw new BadRequestException('generate an email-in address before enabling/disabling it');
    }
    existing.enabled = enabled;
    return this.repo.save(existing);
  }

  /** Create (first call) or rotate (subsequent calls) the per-user token. */
  async generateOrRotateToken(userId: string): Promise<EmailSettingsEntity> {
    const secret = this.requireSecret();
    const token = randomBytes(16).toString('base64url');
    const existing = await this.getEntity(userId);

    if (!existing) {
      const created = this.repo.create({
        userId,
        tokenEncrypted: encryptSecret(token, secret),
        tokenHash: hashToken(token),
        enabled: true,
      });
      return this.repo.save(created);
    }

    existing.tokenEncrypted = encryptSecret(token, secret);
    existing.tokenHash = hashToken(token);
    return this.repo.save(existing);
  }

  /**
   * Resolve the `<token>` extracted from an `inbox+<token>@...` recipient to
   * its owning user. Returns null for an unknown token or one whose owner has
   * paused email ingestion (`enabled: false`) — both are treated identically
   * by the webhook so as not to leak which is which to an outside sender.
   */
  async resolveUserId(token: string): Promise<string | null> {
    const entity = await this.repo.findOne({ where: { tokenHash: hashToken(token) } });
    if (!entity || !entity.enabled) return null;
    return entity.userId;
  }

  private requireSecret(): string {
    const secret = this.config.get<string>('APP_ENCRYPTION_SECRET', '');
    if (!secret) {
      throw new BadRequestException(
        'APP_ENCRYPTION_SECRET is not configured on the server — set it to enable email-in tokens',
      );
    }
    return secret;
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

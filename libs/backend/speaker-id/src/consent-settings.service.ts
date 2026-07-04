import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  ConsentSettingsDto,
  UpdateConsentSettingsRequest,
} from '@plaudern/contracts';
import { ConsentSettingsEntity } from '@plaudern/persistence';

/**
 * Owns the per-user consent-guardian policy rows — at most one per user. Users
 * without a row fall back to the safe defaults (auto-delete off).
 */
@Injectable()
export class ConsentSettingsService {
  constructor(
    @InjectRepository(ConsentSettingsEntity)
    private readonly repo: Repository<ConsentSettingsEntity>,
  ) {}

  async getDto(userId: string): Promise<ConsentSettingsDto> {
    const entity = await this.repo.findOne({ where: { userId } });
    return { autoDeleteDeclined: entity?.autoDeleteDeclined ?? false };
  }

  /** Whether declined-voice recordings should be auto-deleted for this user. */
  async autoDeleteDeclined(userId: string): Promise<boolean> {
    const entity = await this.repo.findOne({ where: { userId } });
    return entity?.autoDeleteDeclined ?? false;
  }

  async upsert(
    userId: string,
    req: UpdateConsentSettingsRequest,
  ): Promise<ConsentSettingsDto> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (existing) {
      existing.autoDeleteDeclined = req.autoDeleteDeclined;
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({ userId, autoDeleteDeclined: req.autoDeleteDeclined }));
    }
    return { autoDeleteDeclined: req.autoDeleteDeclined };
  }
}

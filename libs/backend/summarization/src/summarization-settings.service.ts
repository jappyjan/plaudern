import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  SummarizationSettingsDto,
  SummaryLanguagePreference,
  UpdateSummarizationSettingsRequest,
} from '@plaudern/contracts';
import { SummarizationSettingsEntity } from '@plaudern/persistence';

/** Owns the per-user summarization settings rows — at most one per user. */
@Injectable()
export class SummarizationSettingsService {
  constructor(
    @InjectRepository(SummarizationSettingsEntity)
    private readonly repo: Repository<SummarizationSettingsEntity>,
  ) {}

  async getDto(userId: string): Promise<SummarizationSettingsDto> {
    const entity = await this.repo.findOne({ where: { userId } });
    return { language: entity?.language ?? 'auto' };
  }

  /** The preferred output language for a user's summaries (`auto` by default). */
  async getLanguage(userId: string): Promise<SummaryLanguagePreference> {
    const entity = await this.repo.findOne({ where: { userId } });
    return entity?.language ?? 'auto';
  }

  async upsert(
    userId: string,
    req: UpdateSummarizationSettingsRequest,
  ): Promise<SummarizationSettingsDto> {
    const existing = await this.repo.findOne({ where: { userId } });
    if (existing) {
      existing.language = req.language;
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({ userId, language: req.language }));
    }
    return { language: req.language };
  }
}

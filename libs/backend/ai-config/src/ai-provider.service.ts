import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import type {
  AiProviderDto,
  CreateAiProviderRequest,
  UpdateAiProviderRequest,
} from '@plaudern/contracts';
import { AiProviderEntity, decryptSecret, encryptSecret } from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';

/**
 * Per-user CRUD for AI provider *connections* (credentials). API keys are
 * encrypted at rest (APP_ENCRYPTION_SECRET) and never returned in plaintext —
 * responses carry only `hasApiKey` + a short masked hint, like Plaud's
 * write-only password.
 */
@Injectable()
export class AiProviderService {
  private readonly encryptionSecret: string;

  constructor(
    @InjectRepository(AiProviderEntity)
    private readonly repo: Repository<AiProviderEntity>,
    private readonly aiConfig: AiConfigService,
    config: ConfigService,
  ) {
    this.encryptionSecret = config.get<string>('APP_ENCRYPTION_SECRET', 'change-me');
  }

  async list(userId: string): Promise<AiProviderDto[]> {
    const rows = await this.repo.find({ where: { userId }, order: { createdAt: 'ASC' } });
    return rows.map((row) => this.toDto(row));
  }

  async create(userId: string, req: CreateAiProviderRequest): Promise<AiProviderDto> {
    const apiKey = req.apiKey?.trim() ? req.apiKey.trim() : null;
    const entity = this.repo.create({
      userId,
      name: req.name.trim(),
      protocol: req.protocol,
      baseUrl: req.baseUrl.trim(),
      preset: req.preset?.trim() ? req.preset.trim() : null,
      apiKeyEncrypted: apiKey ? encryptSecret(apiKey, this.encryptionSecret) : null,
    });
    const saved = await this.saveUnique(entity);
    this.aiConfig.invalidate(userId);
    return this.toDto(saved);
  }

  async update(
    userId: string,
    id: string,
    req: UpdateAiProviderRequest,
  ): Promise<AiProviderDto> {
    const entity = await this.repo.findOne({ where: { id, userId } });
    if (!entity) throw new NotFoundException('provider not found');

    if (req.name !== undefined) entity.name = req.name.trim();
    if (req.protocol !== undefined) entity.protocol = req.protocol;
    if (req.baseUrl !== undefined) entity.baseUrl = req.baseUrl.trim();
    if (req.preset !== undefined) entity.preset = req.preset?.trim() ? req.preset.trim() : null;
    if (req.apiKey !== undefined) {
      // Empty string clears the key (keyless); a value replaces it; omission
      // (handled by `!== undefined`) keeps the stored one.
      const trimmed = req.apiKey.trim();
      entity.apiKeyEncrypted = trimmed ? encryptSecret(trimmed, this.encryptionSecret) : null;
    }

    const saved = await this.saveUnique(entity);
    this.aiConfig.invalidate(userId);
    return this.toDto(saved);
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.repo.delete({ id, userId });
    if (!result.affected) throw new NotFoundException('provider not found');
    this.aiConfig.invalidate(userId);
  }

  private async saveUnique(entity: AiProviderEntity): Promise<AiProviderEntity> {
    try {
      return await this.repo.save(entity);
    } catch (err) {
      if (err instanceof QueryFailedError && /unique|duplicate/i.test(err.message)) {
        throw new ConflictException('a provider with that name already exists');
      }
      if (err instanceof BadRequestException) throw err;
      throw err;
    }
  }

  private toDto(entity: AiProviderEntity): AiProviderDto {
    let apiKeyHint: string | null = null;
    if (entity.apiKeyEncrypted) {
      try {
        const plain = decryptSecret(entity.apiKeyEncrypted, this.encryptionSecret);
        apiKeyHint = plain.length <= 4 ? '••••' : `••••${plain.slice(-4)}`;
      } catch {
        apiKeyHint = '••••';
      }
    }
    return {
      id: entity.id,
      name: entity.name,
      protocol: entity.protocol,
      baseUrl: entity.baseUrl,
      preset: entity.preset ?? null,
      hasApiKey: entity.apiKeyEncrypted !== null,
      apiKeyHint,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
    };
  }
}

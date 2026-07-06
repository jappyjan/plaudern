import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  AiCapability,
  AiCapabilitiesResponseDto,
  AiCapabilitySettingDto,
  UpdateAiCapabilityRequest,
} from '@plaudern/contracts';
import { AiCapabilitySettingEntity, AiProviderEntity } from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';
import { ALL_CAPABILITIES, capabilityCatalog, capabilityMeta } from './capability-registry';

/**
 * Per-user CRUD for capability→provider assignments. The GET returns the static
 * catalog (for rendering the UI) alongside the user's current settings, each
 * flagged `active` (whether it currently resolves to a usable provider).
 */
@Injectable()
export class AiCapabilityService {
  constructor(
    @InjectRepository(AiCapabilitySettingEntity)
    private readonly repo: Repository<AiCapabilitySettingEntity>,
    @InjectRepository(AiProviderEntity)
    private readonly providers: Repository<AiProviderEntity>,
    private readonly aiConfig: AiConfigService,
  ) {}

  async getResponse(userId: string): Promise<AiCapabilitiesResponseDto> {
    const rows = await this.repo.find({ where: { userId } });
    const byCapability = new Map(rows.map((r) => [r.capability as AiCapability, r]));
    const settings: AiCapabilitySettingDto[] = [];
    for (const capability of ALL_CAPABILITIES) {
      const row = byCapability.get(capability);
      settings.push({
        capability,
        providerId: row?.providerId ?? null,
        model: row?.model ?? null,
        timeoutMs: row?.timeoutMs ?? null,
        enabled: row?.enabled ?? true,
        params: row?.params ?? {},
        active: await this.aiConfig.isEnabled(userId, capability),
      });
    }
    return { catalog: capabilityCatalog(), settings };
  }

  async upsert(
    userId: string,
    capability: AiCapability,
    req: UpdateAiCapabilityRequest,
  ): Promise<AiCapabilitySettingDto> {
    const meta = capabilityMeta(capability);

    if (req.providerId) {
      const provider = await this.providers.findOne({
        where: { id: req.providerId, userId },
      });
      if (!provider) throw new BadRequestException('provider not found');
      if (!meta.compatibleProtocols.includes(provider.protocol)) {
        throw new BadRequestException(
          `provider protocol '${provider.protocol}' is not compatible with capability '${capability}'`,
        );
      }
    }

    let row = await this.repo.findOne({ where: { userId, capability } });
    if (!row) {
      row = this.repo.create({ userId, capability, enabled: true });
    }
    row.providerId = req.providerId;
    if (req.model !== undefined) row.model = req.model?.trim() ? req.model.trim() : null;
    if (req.timeoutMs !== undefined) row.timeoutMs = req.timeoutMs;
    if (req.enabled !== undefined) row.enabled = req.enabled;
    if (req.params !== undefined) row.params = req.params;
    await this.repo.save(row);
    this.aiConfig.invalidate(userId);

    return {
      capability,
      providerId: row.providerId,
      model: row.model,
      timeoutMs: row.timeoutMs,
      enabled: row.enabled,
      params: row.params ?? {},
      active: await this.aiConfig.isEnabled(userId, capability),
    };
  }
}

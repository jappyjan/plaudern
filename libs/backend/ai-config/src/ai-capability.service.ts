import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  AiCapability,
  AiCapabilityGroupDto,
  AiCapabilityGroupsResponseDto,
  AiCapabilityKind,
  AiCapabilitiesResponseDto,
  AiCapabilitySettingDto,
  UpdateAiCapabilityGroupRequest,
  UpdateAiCapabilityRequest,
} from '@plaudern/contracts';
import {
  AiCapabilityGroupSettingEntity,
  AiCapabilitySettingEntity,
  AiProviderEntity,
} from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';
import {
  ALL_CAPABILITIES,
  capabilitiesOfKind,
  capabilityCatalog,
  capabilityGroupMeta,
  capabilityGroups,
  capabilityMeta,
} from './capability-registry';

/**
 * A per-task setting row counts as an *override* — as opposed to a leftover
 * empty row — when it actually diverges from pure inheritance from the group.
 */
function isOverride(row: AiCapabilitySettingEntity | undefined): boolean {
  if (!row) return false;
  return (
    row.providerId != null ||
    row.model != null ||
    row.timeoutMs != null ||
    row.enabled === false ||
    (row.params != null && Object.keys(row.params).length > 0)
  );
}

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
    @InjectRepository(AiCapabilityGroupSettingEntity)
    private readonly groupRepo: Repository<AiCapabilityGroupSettingEntity>,
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

  /* ---- Capability groups (the simplified, kind-level settings) ----------- */

  /**
   * The five capability groups with this user's shared settings, plus the
   * per-capability catalog + settings the Advanced view still needs.
   */
  async getGroups(userId: string): Promise<AiCapabilityGroupsResponseDto> {
    const groups: AiCapabilityGroupDto[] = [];
    for (const meta of capabilityGroups()) {
      groups.push(await this.buildGroupDto(userId, meta.kind));
    }

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
    return { groups, catalog: capabilityCatalog(), settings };
  }

  /** Upsert one group's shared provider/model/params. */
  async updateGroup(
    userId: string,
    kind: AiCapabilityKind,
    req: UpdateAiCapabilityGroupRequest,
  ): Promise<AiCapabilityGroupDto> {
    const meta = capabilityGroupMeta(kind);

    if (req.providerId) {
      const provider = await this.providers.findOne({ where: { id: req.providerId, userId } });
      if (!provider) throw new BadRequestException('provider not found');
      if (!meta.compatibleProtocols.includes(provider.protocol)) {
        throw new BadRequestException(
          `provider protocol '${provider.protocol}' is not compatible with the ${meta.label} group`,
        );
      }
    }

    let row = await this.groupRepo.findOne({ where: { userId, kind } });
    if (!row) row = this.groupRepo.create({ userId, kind, enabled: true });
    row.providerId = req.providerId;
    if (req.model !== undefined) row.model = req.model?.trim() ? req.model.trim() : null;
    if (req.timeoutMs !== undefined) row.timeoutMs = req.timeoutMs;
    if (req.enabled !== undefined) row.enabled = req.enabled;
    if (req.params !== undefined) row.params = req.params;
    await this.groupRepo.save(row);
    this.aiConfig.invalidate(userId);

    return this.buildGroupDto(userId, kind);
  }

  /** Drop every per-task override in a group so members fall back to shared. */
  async resetGroupOverrides(
    userId: string,
    kind: AiCapabilityKind,
  ): Promise<AiCapabilityGroupDto> {
    const members = capabilitiesOfKind(kind);
    await this.repo.delete({ userId, capability: In(members) });
    this.aiConfig.invalidate(userId);
    return this.buildGroupDto(userId, kind);
  }

  private async buildGroupDto(
    userId: string,
    kind: AiCapabilityKind,
  ): Promise<AiCapabilityGroupDto> {
    const meta = capabilityGroupMeta(kind);
    const [groupRow, settingRows] = await Promise.all([
      this.groupRepo.findOne({ where: { userId, kind } }),
      this.repo.find({ where: { userId, capability: In(meta.memberCapabilities) } }),
    ]);
    const bySetting = new Map(settingRows.map((r) => [r.capability as AiCapability, r]));

    const overriddenCapabilities = meta.memberCapabilities.filter((c) =>
      isOverride(bySetting.get(c)),
    );
    let active = false;
    for (const c of meta.memberCapabilities) {
      if (await this.aiConfig.isEnabled(userId, c)) {
        active = true;
        break;
      }
    }

    return {
      kind: meta.kind,
      label: meta.label,
      description: meta.description,
      compatibleProtocols: meta.compatibleProtocols,
      defaultModel: meta.defaultModel,
      defaultBaseUrl: meta.defaultBaseUrl,
      params: meta.params,
      providerId: groupRow?.providerId ?? null,
      model: groupRow?.model ?? null,
      timeoutMs: groupRow?.timeoutMs ?? null,
      paramValues: groupRow?.params ?? {},
      enabled: groupRow?.enabled ?? true,
      active,
      memberCapabilities: meta.memberCapabilities,
      overriddenCapabilities,
    };
  }
}

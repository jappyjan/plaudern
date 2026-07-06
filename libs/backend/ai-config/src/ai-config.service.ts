import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AiCapability, AiCapabilityKind } from '@plaudern/contracts';
import {
  AiCapabilityGroupSettingEntity,
  AiCapabilitySettingEntity,
  AiProviderEntity,
  decryptSecret,
} from '@plaudern/persistence';
import { capabilityMeta } from './capability-registry';
import type { ResolvedAiConfig } from './resolved-config';

interface UserAiConfig {
  providers: Map<string, AiProviderEntity>;
  /** Per-task overrides (sparse — a row exists only when the user overrides). */
  settings: Map<AiCapability, AiCapabilitySettingEntity>;
  /** Shared, kind-level settings (the simplified groups). */
  groups: Map<AiCapabilityKind, AiCapabilityGroupSettingEntity>;
}

/**
 * Resolves a user's AI configuration per capability from the DB (the
 * `ai_providers` + `ai_capability_settings` tables), replacing the old
 * construction-time `ConfigService.get('<PREFIX>_*')` reads. Providers call
 * `resolve(userId, capability)` per request; a null result means "not
 * configured / disabled" and the caller no-ops (same semantics an empty API key
 * used to have).
 *
 * The raw rows are cached per user and invalidated whenever the user edits their
 * providers/capabilities, so hot pipeline paths don't hit the DB on every call.
 */
@Injectable()
export class AiConfigService {
  private readonly logger = new Logger(AiConfigService.name);
  private readonly cache = new Map<string, Promise<UserAiConfig>>();
  private readonly encryptionSecret: string;

  constructor(
    @InjectRepository(AiProviderEntity)
    private readonly providers: Repository<AiProviderEntity>,
    @InjectRepository(AiCapabilitySettingEntity)
    private readonly capabilities: Repository<AiCapabilitySettingEntity>,
    @InjectRepository(AiCapabilityGroupSettingEntity)
    private readonly groups: Repository<AiCapabilityGroupSettingEntity>,
    config: ConfigService,
  ) {
    this.encryptionSecret = config.get<string>('APP_ENCRYPTION_SECRET', 'change-me');
  }

  /** Drop a user's cached config after they edit providers/capabilities. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  private load(userId: string): Promise<UserAiConfig> {
    const cached = this.cache.get(userId);
    if (cached) return cached;
    const loading = this.loadFresh(userId);
    this.cache.set(userId, loading);
    // If the load fails, don't poison the cache with a rejected promise.
    loading.catch(() => this.cache.delete(userId));
    return loading;
  }

  private async loadFresh(userId: string): Promise<UserAiConfig> {
    const [providerRows, settingRows, groupRows] = await Promise.all([
      this.providers.find({ where: { userId } }),
      this.capabilities.find({ where: { userId } }),
      this.groups.find({ where: { userId } }),
    ]);
    return {
      providers: new Map(providerRows.map((p) => [p.id, p])),
      settings: new Map(settingRows.map((s) => [s.capability as AiCapability, s])),
      groups: new Map(groupRows.map((g) => [g.kind as AiCapabilityKind, g])),
    };
  }

  /**
   * Resolve the ready-to-use config for one capability, or null when the user
   * has not configured a usable provider for it (directly or via inheritance),
   * or has explicitly disabled it.
   */
  async resolve(userId: string, capability: AiCapability): Promise<ResolvedAiConfig | null> {
    const user = await this.load(userId);
    return this.resolveFrom(user, capability);
  }

  /** Whether the capability currently resolves to a usable provider. */
  async isEnabled(userId: string, capability: AiCapability): Promise<boolean> {
    return (await this.resolve(userId, capability)) !== null;
  }

  private resolveFrom(user: UserAiConfig, capability: AiCapability): ResolvedAiConfig | null {
    const meta = capabilityMeta(capability);
    const override = user.settings.get(capability);
    const group = user.groups.get(meta.kind);

    // Disable checks: an explicit per-task disable, or the whole group off.
    if (override && override.enabled === false) return null;
    if (group && group.enabled === false) return null;

    // Opt-in capabilities (only web_research) stay off unless the user has
    // explicitly enabled them with their own provider in the Advanced view —
    // configuring the shared chat group must not silently switch them on.
    if (meta.optIn && !(override?.providerId && override.enabled !== false)) return null;

    // Layer the setting: per-task override ?? shared group ?? registry default.
    const providerId = override?.providerId ?? group?.providerId ?? null;
    if (!providerId) return null;
    const provider = user.providers.get(providerId);
    if (!provider) return null;

    const model = override?.model ?? group?.model ?? meta.defaultModel;
    if (!model) return null;

    let apiKey: string | null = null;
    if (provider.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(provider.apiKeyEncrypted, this.encryptionSecret);
      } catch (err) {
        this.logger.error(
          `failed to decrypt API key for provider '${provider.name}' (${provider.id}): ${(err as Error).message}`,
        );
        return null;
      }
    }

    return {
      capability,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl.replace(/\/+$/, ''),
      apiKey,
      model,
      timeoutMs: override?.timeoutMs ?? group?.timeoutMs ?? meta.defaultTimeoutMs,
      params: {
        ...meta.defaultParams,
        ...(group?.params ?? {}),
        ...(override?.params ?? {}),
      },
      providerId: provider.id,
      providerName: provider.name,
    };
  }
}

import type { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AiConfigService } from '@plaudern/ai-config';
import type { AiCapability, AiProviderProtocol } from '@plaudern/contracts';
import {
  AiCapabilitySettingEntity,
  AiProviderEntity,
  DEFAULT_USER_ID,
  encryptSecret,
} from '@plaudern/persistence';

/**
 * Test helper: enable an AI capability for a user by seeding the DB the same way
 * the real Settings → AI flow would — a provider connection plus a capability
 * assignment — then invalidating the resolver cache. This replaces the old
 * "set <PREFIX>_API_KEY in process.env" pattern now that AI config is per-user
 * in the DB. The concrete provider is still overridden with a fake in most
 * specs; this only flips the DB-driven enablement gate.
 */
export async function seedAiCapability(
  app: INestApplication,
  capability: AiCapability,
  opts: {
    userId?: string;
    protocol?: AiProviderProtocol;
    baseUrl?: string;
    model?: string;
    /** Pass null for a keyless local provider. */
    apiKey?: string | null;
    params?: Record<string, unknown>;
    providerName?: string;
  } = {},
): Promise<void> {
  const userId = opts.userId ?? DEFAULT_USER_ID;
  const providerName = opts.providerName ?? 'test-provider';
  const encryptionSecret = process.env.APP_ENCRYPTION_SECRET ?? 'change-me';

  const providerRepo = app.get<Repository<AiProviderEntity>>(
    getRepositoryToken(AiProviderEntity),
  );
  const capabilityRepo = app.get<Repository<AiCapabilitySettingEntity>>(
    getRepositoryToken(AiCapabilitySettingEntity),
  );

  const apiKey = opts.apiKey === undefined ? 'test-key' : opts.apiKey;
  let provider = await providerRepo.findOne({ where: { userId, name: providerName } });
  if (!provider) {
    provider = await providerRepo.save(
      providerRepo.create({
        userId,
        name: providerName,
        protocol: opts.protocol ?? 'openai-compatible',
        baseUrl: opts.baseUrl ?? 'https://provider.test/v1',
        apiKeyEncrypted: apiKey === null ? null : encryptSecret(apiKey, encryptionSecret),
      }),
    );
  }

  const existing = await capabilityRepo.findOne({ where: { userId, capability } });
  await capabilityRepo.save(
    capabilityRepo.create({
      id: existing?.id,
      userId,
      capability,
      providerId: provider.id,
      model: opts.model ?? null,
      enabled: true,
      params: opts.params ?? null,
    }),
  );

  app.get(AiConfigService).invalidate(userId);
}

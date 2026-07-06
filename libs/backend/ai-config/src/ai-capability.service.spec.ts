import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import {
  AiCapabilitySettingEntity,
  AiProviderEntity,
  ALL_ENTITIES,
  encryptSecret,
} from '@plaudern/persistence';
import { AiCapabilityService } from './ai-capability.service';
import { AiConfigService } from './ai-config.service';
import { ALL_CAPABILITIES } from './capability-registry';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SECRET = 'test-secret';

const fakeConfig = {
  get: (key: string, def?: unknown) =>
    (({ APP_ENCRYPTION_SECRET: SECRET } as Record<string, unknown>)[key] ?? def),
} as unknown as ConfigService;

describe('AiCapabilityService', () => {
  let dataSource: DataSource;
  let providers: Repository<AiProviderEntity>;
  let capabilities: Repository<AiCapabilitySettingEntity>;
  let aiConfig: AiConfigService;
  let service: AiCapabilityService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    providers = dataSource.getRepository(AiProviderEntity);
    capabilities = dataSource.getRepository(AiCapabilitySettingEntity);
    aiConfig = new AiConfigService(providers, capabilities, fakeConfig);
    service = new AiCapabilityService(capabilities, providers, aiConfig);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createProvider(
    overrides: Partial<AiProviderEntity> = {},
  ): Promise<AiProviderEntity> {
    return providers.save(
      providers.create({
        userId: USER,
        name: overrides.name ?? 'DeepSeek',
        protocol: overrides.protocol ?? 'openai-compatible',
        baseUrl: overrides.baseUrl ?? 'https://api.deepseek.com/v1',
        apiKeyEncrypted: encryptSecret('sk-secret', SECRET),
        ...overrides,
      }),
    );
  }

  describe('getResponse', () => {
    it('returns the full catalog and a settings entry per capability', async () => {
      const res = await service.getResponse(USER);
      expect(res.catalog).toHaveLength(ALL_CAPABILITIES.length);
      expect(res.settings).toHaveLength(ALL_CAPABILITIES.length);
      // Defaults with no rows: enabled true, providerId null, not active.
      const summary = res.settings.find((s) => s.capability === 'summarization');
      expect(summary).toMatchObject({
        providerId: null,
        model: null,
        enabled: true,
        active: false,
      });
    });

    it('marks a capability active only once it resolves to a usable provider', async () => {
      const provider = await createProvider();
      await service.upsert(USER, 'summarization', { providerId: provider.id });

      const res = await service.getResponse(USER);
      const summary = res.settings.find((s) => s.capability === 'summarization');
      expect(summary?.active).toBe(true);

      // chat inherits summarization's provider, so it is active too.
      const chat = res.settings.find((s) => s.capability === 'chat');
      expect(chat?.active).toBe(true);

      // ocr does not inherit — still inactive.
      const ocr = res.settings.find((s) => s.capability === 'ocr');
      expect(ocr?.active).toBe(false);
    });

    it('reflects a disabled row as inactive', async () => {
      const provider = await createProvider();
      await service.upsert(USER, 'summarization', { providerId: provider.id, enabled: false });
      const res = await service.getResponse(USER);
      const summary = res.settings.find((s) => s.capability === 'summarization');
      expect(summary?.enabled).toBe(false);
      expect(summary?.active).toBe(false);
    });
  });

  describe('upsert', () => {
    it('assigns a compatible provider and returns active=true', async () => {
      const provider = await createProvider();
      const dto = await service.upsert(USER, 'summarization', {
        providerId: provider.id,
        model: 'deepseek-reasoner',
      });
      expect(dto).toMatchObject({
        capability: 'summarization',
        providerId: provider.id,
        model: 'deepseek-reasoner',
        enabled: true,
        active: true,
      });
    });

    it('rejects a provider whose protocol is incompatible with the capability', async () => {
      // summarization needs an openai-compatible chat provider; give it elevenlabs.
      const provider = await createProvider({
        name: 'ElevenLabs',
        protocol: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io/v1',
      });
      await expect(
        service.upsert(USER, 'summarization', { providerId: provider.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a providerId that does not belong to the user', async () => {
      await expect(
        service.upsert(USER, 'summarization', {
          providerId: '00000000-0000-0000-0000-0000000000ff',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('disables the capability when providerId is null', async () => {
      const provider = await createProvider();
      await service.upsert(USER, 'summarization', { providerId: provider.id });
      const dto = await service.upsert(USER, 'summarization', { providerId: null });
      expect(dto.providerId).toBeNull();
      expect(dto.active).toBe(false);
      expect(await aiConfig.isEnabled(USER, 'summarization')).toBe(false);
    });

    it('updates an existing row in place (single row per user+capability)', async () => {
      const provider = await createProvider();
      await service.upsert(USER, 'summarization', { providerId: provider.id, model: 'a' });
      await service.upsert(USER, 'summarization', { providerId: provider.id, model: 'b' });
      const rows = await capabilities.find({ where: { userId: USER, capability: 'summarization' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].model).toBe('b');
    });
  });
});

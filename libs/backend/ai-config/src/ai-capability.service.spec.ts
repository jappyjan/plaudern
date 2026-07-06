import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import {
  AiCapabilityGroupSettingEntity,
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
  let groupRepo: Repository<AiCapabilityGroupSettingEntity>;
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
    groupRepo = dataSource.getRepository(AiCapabilityGroupSettingEntity);
    aiConfig = new AiConfigService(providers, capabilities, groupRepo, fakeConfig);
    service = new AiCapabilityService(capabilities, groupRepo, providers, aiConfig);
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

    it('marks only the overridden capability active (per-task override, no group)', async () => {
      const provider = await createProvider();
      await service.upsert(USER, 'summarization', { providerId: provider.id });

      const res = await service.getResponse(USER);
      const summary = res.settings.find((s) => s.capability === 'summarization');
      expect(summary?.active).toBe(true);

      // A per-task override on summarization does NOT power its siblings — that
      // is what the shared chat group is for.
      const chat = res.settings.find((s) => s.capability === 'chat');
      expect(chat?.active).toBe(false);

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

  describe('capability groups', () => {
    it('getGroups returns the five kind-level groups', async () => {
      const res = await service.getGroups(USER);
      expect(res.groups.map((g) => g.kind)).toEqual([
        'chat',
        'vision',
        'embeddings',
        'stt',
        'diarization',
      ]);
      const chat = res.groups.find((g) => g.kind === 'chat');
      expect(chat?.memberCapabilities).toContain('summarization');
      expect(chat?.memberCapabilities).toContain('journal');
      expect(chat?.active).toBe(false);
    });

    it('updateGroup powers every member of the kind', async () => {
      const provider = await createProvider();
      const dto = await service.updateGroup(USER, 'chat', { providerId: provider.id });
      expect(dto.active).toBe(true);
      expect(await aiConfig.isEnabled(USER, 'summarization')).toBe(true);
      expect(await aiConfig.isEnabled(USER, 'journal')).toBe(true);
      // vision is a different kind — untouched.
      expect(await aiConfig.isEnabled(USER, 'ocr')).toBe(false);
    });

    it('updateGroup rejects an incompatible provider protocol', async () => {
      const provider = await createProvider({
        name: 'ElevenLabs',
        protocol: 'elevenlabs',
        baseUrl: 'https://api.elevenlabs.io/v1',
      });
      await expect(
        service.updateGroup(USER, 'chat', { providerId: provider.id }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports and resets per-task overrides', async () => {
      const shared = await createProvider({ name: 'Shared' });
      const special = await createProvider({ name: 'Special' });
      await service.updateGroup(USER, 'chat', { providerId: shared.id });
      await service.upsert(USER, 'journal', { providerId: special.id, model: 'special-model' });

      let groups = (await service.getGroups(USER)).groups;
      expect(groups.find((g) => g.kind === 'chat')?.overriddenCapabilities).toContain('journal');

      const reset = await service.resetGroupOverrides(USER, 'chat');
      expect(reset.overriddenCapabilities).toEqual([]);
      // journal now inherits the shared group again.
      const resolved = await aiConfig.resolve(USER, 'journal');
      expect(resolved?.providerId).toBe(shared.id);

      groups = (await service.getGroups(USER)).groups;
      expect(groups.find((g) => g.kind === 'chat')?.overriddenCapabilities).toEqual([]);
    });
  });
});

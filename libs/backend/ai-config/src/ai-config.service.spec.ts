import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import type { AiCapabilityKind } from '@plaudern/contracts';
import {
  AiCapabilityGroupSettingEntity,
  AiCapabilitySettingEntity,
  AiProviderEntity,
  ALL_ENTITIES,
  encryptSecret,
} from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SECRET = 'test-secret';

const fakeConfig = {
  get: (key: string, def?: unknown) =>
    (({ APP_ENCRYPTION_SECRET: SECRET } as Record<string, unknown>)[key] ?? def),
} as unknown as ConfigService;

describe('AiConfigService', () => {
  let dataSource: DataSource;
  let providers: Repository<AiProviderEntity>;
  let capabilities: Repository<AiCapabilitySettingEntity>;
  let groups: Repository<AiCapabilityGroupSettingEntity>;
  let service: AiConfigService;

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
    groups = dataSource.getRepository(AiCapabilityGroupSettingEntity);
    service = new AiConfigService(providers, capabilities, groups, fakeConfig);
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
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKeyEncrypted: encryptSecret('sk-secret-key', SECRET),
        ...overrides,
      }),
    );
  }

  async function assign(
    capability: AiCapabilitySettingEntity['capability'],
    row: Partial<AiCapabilitySettingEntity>,
  ): Promise<AiCapabilitySettingEntity> {
    return capabilities.save(
      capabilities.create({ userId: USER, capability, enabled: true, ...row }),
    );
  }

  async function setGroup(
    kind: AiCapabilityKind,
    row: Partial<AiCapabilityGroupSettingEntity>,
  ): Promise<AiCapabilityGroupSettingEntity> {
    return groups.save(groups.create({ userId: USER, kind, enabled: true, ...row }));
  }

  describe('resolve / isEnabled — null cases', () => {
    it('returns null when there is no capability row and no provider', async () => {
      expect(await service.resolve(USER, 'summarization')).toBeNull();
      expect(await service.isEnabled(USER, 'summarization')).toBe(false);
    });

    it('returns null when a row exists but no provider is assigned', async () => {
      await assign('summarization', { providerId: null });
      expect(await service.resolve(USER, 'summarization')).toBeNull();
    });

    it('returns null when the row is explicitly disabled', async () => {
      const provider = await createProvider();
      await assign('summarization', { providerId: provider.id, enabled: false });
      expect(await service.resolve(USER, 'summarization')).toBeNull();
      expect(await service.isEnabled(USER, 'summarization')).toBe(false);
    });
  });

  describe('resolve — happy path', () => {
    it('resolves baseUrl + decrypted apiKey + model + merged params', async () => {
      const provider = await createProvider({ baseUrl: 'https://api.deepseek.com/v1///' });
      await assign('embeddings', {
        providerId: provider.id,
        // registry default params { dimensions: 1536 } merged with override
        params: { dimensions: 512 },
      });

      const resolved = await service.resolve(USER, 'embeddings');
      expect(resolved).not.toBeNull();
      expect(resolved).toMatchObject({
        capability: 'embeddings',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1', // trailing slashes trimmed
        apiKey: 'sk-secret-key', // decrypted
        model: 'text-embedding-3-small', // registry default
        timeoutMs: 120_000,
        params: { dimensions: 512 }, // override wins over default 1536
        providerId: provider.id,
        providerName: 'DeepSeek',
      });
      expect(await service.isEnabled(USER, 'embeddings')).toBe(true);
    });

    it('uses the row model override over the registry default', async () => {
      const provider = await createProvider();
      await assign('summarization', { providerId: provider.id, model: 'deepseek-reasoner' });
      const resolved = await service.resolve(USER, 'summarization');
      expect(resolved?.model).toBe('deepseek-reasoner');
    });

    it('merges registry default params when the row has none', async () => {
      const provider = await createProvider();
      await assign('embeddings', { providerId: provider.id, params: null });
      const resolved = await service.resolve(USER, 'embeddings');
      expect(resolved?.params).toEqual({ dimensions: 1536 });
    });
  });

  describe('group layer', () => {
    it('one chat group powers every chat capability with each one’s own default model', async () => {
      const provider = await createProvider({ name: 'Shared DeepSeek' });
      // A single shared group setting for the whole chat kind, with a group-level
      // model that members inherit when they have no override of their own.
      await setGroup('chat', { providerId: provider.id });

      for (const capability of ['summarization', 'chat', 'journal', 'entity_extraction'] as const) {
        const resolved = await service.resolve(USER, capability);
        expect(resolved).not.toBeNull();
        expect(resolved?.providerId).toBe(provider.id);
        expect(resolved?.providerName).toBe('Shared DeepSeek');
        expect(resolved?.apiKey).toBe('sk-secret-key');
        expect(resolved?.model).toBe('deepseek-chat'); // each capability's registry default
      }
    });

    it('a per-task override wins over the shared group', async () => {
      const shared = await createProvider({ name: 'Shared' });
      const special = await createProvider({
        name: 'Special',
        baseUrl: 'https://api.openai.com/v1',
      });
      await setGroup('chat', { providerId: shared.id, model: 'group-model' });
      await assign('journal', { providerId: special.id, model: 'journal-model' });

      const summary = await service.resolve(USER, 'summarization');
      expect(summary?.providerId).toBe(shared.id);
      expect(summary?.model).toBe('group-model'); // group model wins over registry default

      const journal = await service.resolve(USER, 'journal');
      expect(journal?.providerId).toBe(special.id); // override wins
      expect(journal?.model).toBe('journal-model');
    });

    it('the group model fills in for members without an override', async () => {
      const provider = await createProvider();
      await setGroup('chat', { providerId: provider.id, model: 'shared-chat-model' });
      const resolved = await service.resolve(USER, 'topics');
      expect(resolved?.model).toBe('shared-chat-model');
    });

    it('a disabled group turns every member off', async () => {
      const provider = await createProvider();
      await setGroup('chat', { providerId: provider.id, enabled: false });
      expect(await service.resolve(USER, 'summarization')).toBeNull();
      expect(await service.isEnabled(USER, 'chat')).toBe(false);
    });

    it('does not leak the chat group into other kinds', async () => {
      const provider = await createProvider();
      await setGroup('chat', { providerId: provider.id });
      // ocr is kind=vision — the chat group must not power it.
      expect(await service.resolve(USER, 'ocr')).toBeNull();
    });

    it('keeps opt-in web_research off until it has its own enabled override', async () => {
      const provider = await createProvider();
      await setGroup('chat', { providerId: provider.id });
      expect(await service.resolve(USER, 'web_research')).toBeNull();

      await assign('web_research', { providerId: provider.id, enabled: true });
      service.invalidate(USER); // the direct DB write bypasses the service cache
      expect(await service.resolve(USER, 'web_research')).not.toBeNull();
    });
  });

  describe('keyless provider', () => {
    it('resolves with apiKey null and isEnabled true when the key is null', async () => {
      const provider = await createProvider({
        name: 'Local Ollama',
        baseUrl: 'http://localhost:11434/v1',
        apiKeyEncrypted: null,
      });
      await assign('summarization', { providerId: provider.id });
      const resolved = await service.resolve(USER, 'summarization');
      expect(resolved).not.toBeNull();
      expect(resolved?.apiKey).toBeNull();
      expect(await service.isEnabled(USER, 'summarization')).toBe(true);
    });
  });

  describe('caching', () => {
    it('serves the cached config until invalidate is called', async () => {
      const provider = await createProvider();
      await assign('summarization', { providerId: provider.id, model: 'model-a' });

      const first = await service.resolve(USER, 'summarization');
      expect(first?.model).toBe('model-a');

      // Mutate the DB row directly, behind the service's back.
      await capabilities.update(
        { userId: USER, capability: 'summarization' },
        { model: 'model-b' },
      );

      const cached = await service.resolve(USER, 'summarization');
      expect(cached?.model).toBe('model-a'); // still cached

      service.invalidate(USER);
      const fresh = await service.resolve(USER, 'summarization');
      expect(fresh?.model).toBe('model-b'); // reloaded from DB
    });
  });
});

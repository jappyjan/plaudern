import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import {
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
    service = new AiConfigService(providers, capabilities, fakeConfig);
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

  describe('inheritance', () => {
    it('chat and journal inherit summarization provider but keep their own default model', async () => {
      const provider = await createProvider({ name: 'Shared DeepSeek' });
      // Only summarization is assigned, with a model override that children must NOT adopt.
      await assign('summarization', { providerId: provider.id, model: 'custom-summary-model' });

      const summary = await service.resolve(USER, 'summarization');
      expect(summary?.model).toBe('custom-summary-model');

      for (const capability of ['chat', 'journal'] as const) {
        const resolved = await service.resolve(USER, capability);
        expect(resolved).not.toBeNull();
        expect(resolved?.providerId).toBe(provider.id); // inherited connection
        expect(resolved?.providerName).toBe('Shared DeepSeek');
        expect(resolved?.apiKey).toBe('sk-secret-key');
        expect(resolved?.model).toBe('deepseek-chat'); // child's own default, not the override
      }
    });

    it('entity_judge, contact_resolution and entity_relations inherit entity_extraction', async () => {
      const provider = await createProvider({ name: 'Entities' });
      await assign('entity_extraction', {
        providerId: provider.id,
        model: 'entity-model-override',
      });

      for (const capability of [
        'entity_judge',
        'contact_resolution',
        'entity_relations',
      ] as const) {
        const resolved = await service.resolve(USER, capability);
        expect(resolved?.providerId).toBe(provider.id);
        expect(resolved?.model).toBe('deepseek-chat'); // own default, not the parent override
      }
    });

    it('does not inherit for a capability with no inheritsFrom', async () => {
      const provider = await createProvider();
      await assign('summarization', { providerId: provider.id });
      // ocr has no inheritance chain to summarization.
      expect(await service.resolve(USER, 'ocr')).toBeNull();
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

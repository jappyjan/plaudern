import { ConflictException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import {
  AiCapabilityGroupSettingEntity,
  AiCapabilitySettingEntity,
  AiProviderEntity,
  ALL_ENTITIES,
  decryptSecret,
} from '@plaudern/persistence';
import { AiConfigService } from './ai-config.service';
import { AiProviderService } from './ai-provider.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SECRET = 'test-secret';

const fakeConfig = {
  get: (key: string, def?: unknown) =>
    (({ APP_ENCRYPTION_SECRET: SECRET } as Record<string, unknown>)[key] ?? def),
} as unknown as ConfigService;

describe('AiProviderService', () => {
  let dataSource: DataSource;
  let repo: Repository<AiProviderEntity>;
  let aiConfig: AiConfigService;
  let service: AiProviderService;
  let invalidateSpy: jest.SpyInstance;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    repo = dataSource.getRepository(AiProviderEntity);
    aiConfig = new AiConfigService(
      repo,
      dataSource.getRepository(AiCapabilitySettingEntity),
      dataSource.getRepository(AiCapabilityGroupSettingEntity),
      fakeConfig,
    );
    invalidateSpy = jest.spyOn(aiConfig, 'invalidate');
    service = new AiProviderService(repo, aiConfig, fakeConfig);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  describe('create', () => {
    it('encrypts the key and never exposes plaintext (hasApiKey + masked hint)', async () => {
      const dto = await service.create(USER, {
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-abcdef123456',
      });

      expect(dto.hasApiKey).toBe(true);
      expect(dto.apiKeyHint).toBe('••••3456');
      expect(JSON.stringify(dto)).not.toContain('sk-abcdef123456');
      expect((dto as Record<string, unknown>).apiKeyEncrypted).toBeUndefined();

      // The stored ciphertext is not the plaintext and round-trips back.
      const row = await repo.findOneByOrFail({ id: dto.id });
      expect(row.apiKeyEncrypted).not.toContain('sk-abcdef123456');
      expect(decryptSecret(row.apiKeyEncrypted as string, SECRET)).toBe('sk-abcdef123456');
      expect(invalidateSpy).toHaveBeenCalledWith(USER);
    });

    it('stores a keyless provider when apiKey is omitted', async () => {
      const dto = await service.create(USER, {
        name: 'Local',
        protocol: 'openai-compatible',
        baseUrl: 'http://localhost:11434/v1',
      });
      expect(dto.hasApiKey).toBe(false);
      expect(dto.apiKeyHint).toBeNull();
    });

    it('throws ConflictException on a duplicate name for the same user', async () => {
      await service.create(USER, {
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-one',
      });
      await expect(
        service.create(USER, {
          name: 'DeepSeek',
          protocol: 'openai-compatible',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'sk-two',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('clears the stored key when apiKey is an empty string', async () => {
      const created = await service.create(USER, {
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-secret',
      });
      const updated = await service.update(USER, created.id, { apiKey: '' });
      expect(updated.hasApiKey).toBe(false);
      expect(updated.apiKeyHint).toBeNull();
      const row = await repo.findOneByOrFail({ id: created.id });
      expect(row.apiKeyEncrypted).toBeNull();
    });

    it('keeps the stored key when apiKey is omitted', async () => {
      const created = await service.create(USER, {
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-keep-me-1234',
      });
      const updated = await service.update(USER, created.id, { name: 'DeepSeek Renamed' });
      expect(updated.name).toBe('DeepSeek Renamed');
      expect(updated.hasApiKey).toBe(true);
      expect(updated.apiKeyHint).toBe('••••1234');
    });

    it('throws NotFoundException for an unknown id', async () => {
      await expect(
        service.update(USER, '00000000-0000-0000-0000-0000000000ff', { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the provider and invalidates the cache', async () => {
      const created = await service.create(USER, {
        name: 'DeepSeek',
        protocol: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
      });
      invalidateSpy.mockClear();
      await service.remove(USER, created.id);
      expect(await repo.findOneBy({ id: created.id })).toBeNull();
      expect(invalidateSpy).toHaveBeenCalledWith(USER);
    });

    it('throws NotFoundException when deleting an unknown id', async () => {
      await expect(
        service.remove(USER, '00000000-0000-0000-0000-0000000000ff'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

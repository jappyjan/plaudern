import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
  AiProviderEntity,
  CalendarFeedEntity,
  EmailSettingsEntity,
  PlaudSettingsEntity,
} from './entities';
import { decryptSecret, encryptSecret } from './secret-crypto';
import { rotateEncryptionSecret } from './rotate-encryption-secret';

const OLD_SECRET = 'old-secret-that-may-have-been-weak';
const NEW_SECRET = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

describe('rotateEncryptionSecret', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [
        AiProviderEntity,
        CalendarFeedEntity,
        EmailSettingsEntity,
        PlaudSettingsEntity,
      ],
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  it('rotates every persisted encrypted field in one transaction', async () => {
    const userId = randomUUID();
    await dataSource.getRepository(AiProviderEntity).save({
      userId,
      name: 'provider',
      protocol: 'openai-compatible',
      baseUrl: 'https://provider.test',
      preset: null,
      apiKeyEncrypted: encryptSecret('api-key', OLD_SECRET),
    });
    await dataSource.getRepository(AiProviderEntity).save(
      Array.from({ length: 100 }, (_, index) => ({
        userId,
        name: `provider-${index}`,
        protocol: 'openai-compatible' as const,
        baseUrl: 'https://provider.test',
        preset: null,
        apiKeyEncrypted: encryptSecret(`api-key-${index}`, OLD_SECRET),
      })),
    );
    await dataSource.getRepository(PlaudSettingsEntity).save({
      userId,
      email: 'user@example.test',
      passwordEncrypted: encryptSecret('password', OLD_SECRET),
      region: 'us',
      enabled: true,
    });
    await dataSource.getRepository(CalendarFeedEntity).save({
      userId,
      name: 'calendar',
      providerType: 'ics',
      urlEncrypted: encryptSecret('https://calendar.test/secret', OLD_SECRET),
      googleRefreshTokenEncrypted: encryptSecret('refresh-token', OLD_SECRET),
    });
    await dataSource.getRepository(EmailSettingsEntity).save({
      userId,
      tokenEncrypted: encryptSecret('email-token', OLD_SECRET),
      tokenHash: 'hash',
    });

    await expect(rotateEncryptionSecret(dataSource, OLD_SECRET, NEW_SECRET)).resolves.toBe(105);

    const provider = await dataSource.getRepository(AiProviderEntity).findOneByOrFail({ userId });
    const plaud = await dataSource.getRepository(PlaudSettingsEntity).findOneByOrFail({ userId });
    const calendar = await dataSource.getRepository(CalendarFeedEntity).findOneByOrFail({ userId });
    const email = await dataSource.getRepository(EmailSettingsEntity).findOneByOrFail({ userId });
    expect(decryptSecret(provider.apiKeyEncrypted!, NEW_SECRET)).toBe('api-key');
    const lastProvider = await dataSource
      .getRepository(AiProviderEntity)
      .findOneByOrFail({ userId, name: 'provider-99' });
    expect(decryptSecret(lastProvider.apiKeyEncrypted!, NEW_SECRET)).toBe('api-key-99');
    expect(decryptSecret(plaud.passwordEncrypted, NEW_SECRET)).toBe('password');
    expect(decryptSecret(calendar.urlEncrypted!, NEW_SECRET)).toBe('https://calendar.test/secret');
    expect(decryptSecret(calendar.googleRefreshTokenEncrypted!, NEW_SECRET)).toBe('refresh-token');
    expect(decryptSecret(email.tokenEncrypted, NEW_SECRET)).toBe('email-token');
  });

  it('rolls back all changes when any ciphertext cannot be decrypted', async () => {
    const userId = randomUUID();
    const original = encryptSecret('api-key', OLD_SECRET);
    await dataSource.getRepository(AiProviderEntity).save({
      userId,
      name: 'provider',
      protocol: 'openai-compatible',
      baseUrl: 'https://provider.test',
      preset: null,
      apiKeyEncrypted: original,
    });
    await dataSource.getRepository(EmailSettingsEntity).save({
      userId,
      tokenEncrypted: 'not-ciphertext',
      tokenHash: 'hash',
    });

    await expect(rotateEncryptionSecret(dataSource, OLD_SECRET, NEW_SECRET)).rejects.toThrow();

    const provider = await dataSource.getRepository(AiProviderEntity).findOneByOrFail({ userId });
    expect(provider.apiKeyEncrypted).toBe(original);
    expect(decryptSecret(provider.apiKeyEncrypted!, OLD_SECRET)).toBe('api-key');
  });
});

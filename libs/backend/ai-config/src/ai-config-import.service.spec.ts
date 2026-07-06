import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import {
  AiCapabilitySettingEntity,
  AiProviderEntity,
  ALL_ENTITIES,
  DEFAULT_USER_ID,
  decryptSecret,
} from '@plaudern/persistence';
import { AiConfigImportService } from './ai-config-import.service';

const SECRET = 'test-secret';

/**
 * The import service reads legacy env through ConfigService.get(key) — back it
 * with process.env (like the real ConfigService) plus the encryption secret.
 */
const envConfig = {
  get: (key: string, def?: unknown) => {
    if (key === 'APP_ENCRYPTION_SECRET') return SECRET;
    return process.env[key] ?? def;
  },
} as unknown as ConfigService;

// Every legacy env var these tests touch, so we can restore process.env cleanly.
const LEGACY_KEYS = [
  'SUMMARIZATION_API_KEY',
  'ENTITY_EXTRACTION_API_KEY',
  'TASKS_API_KEY',
  'EMBEDDINGS_API_KEY',
  'OCR_API_KEY',
  'ELEVENLABS_API_KEY',
  'PYANNOTEAI_API_KEY',
];

describe('AiConfigImportService.onModuleInit', () => {
  let dataSource: DataSource;
  let providers: Repository<AiProviderEntity>;
  let capabilities: Repository<AiCapabilitySettingEntity>;
  let service: AiConfigImportService;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = {};
    for (const key of LEGACY_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    providers = dataSource.getRepository(AiProviderEntity);
    capabilities = dataSource.getRepository(AiCapabilitySettingEntity);
    service = new AiConfigImportService(providers, capabilities, envConfig);
  });

  afterEach(async () => {
    for (const key of LEGACY_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await dataSource.destroy();
  });

  it('seeds nothing when no legacy AI env is set', async () => {
    await service.onModuleInit();
    expect(await providers.count()).toBe(0);
    expect(await capabilities.count()).toBe(0);
  });

  it('imports providers (de-duplicated) and capability rows for DEFAULT_USER_ID', async () => {
    // Three DeepSeek-keyed capabilities share ONE key + base URL → one connection.
    process.env.SUMMARIZATION_API_KEY = 'deepseek-key';
    process.env.ENTITY_EXTRACTION_API_KEY = 'deepseek-key';
    process.env.TASKS_API_KEY = 'deepseek-key';
    // Two OpenAI-hosted capabilities with distinct keys → two more connections.
    process.env.EMBEDDINGS_API_KEY = 'openai-embed-key';
    process.env.OCR_API_KEY = 'openai-vision-key';
    // Non-openai protocols.
    process.env.ELEVENLABS_API_KEY = 'eleven-key';
    process.env.PYANNOTEAI_API_KEY = 'pyannote-key';

    await service.onModuleInit();

    const providerRows = await providers.find();
    // deepseek(shared) + openai-embeddings + openai-ocr + elevenlabs + pyannoteai = 5
    expect(providerRows).toHaveLength(5);
    expect(providerRows.every((p) => p.userId === DEFAULT_USER_ID)).toBe(true);

    // Exactly one DeepSeek connection, shared by the three deepseek capabilities.
    const deepseek = providerRows.filter((p) => p.baseUrl === 'https://api.deepseek.com/v1');
    expect(deepseek).toHaveLength(1);
    expect(decryptSecret(deepseek[0].apiKeyEncrypted as string, SECRET)).toBe('deepseek-key');

    // Two OpenAI connections got unique names despite the same hostname.
    const openaiNames = providerRows
      .filter((p) => p.baseUrl === 'https://api.openai.com/v1')
      .map((p) => p.name)
      .sort();
    expect(openaiNames).toEqual(['api.openai.com', 'api.openai.com 2']);

    const capRows = await capabilities.find();
    const importedCaps = capRows.map((c) => c.capability).sort();
    expect(importedCaps).toEqual(
      [
        'summarization',
        'entity_extraction',
        'tasks',
        'embeddings',
        'ocr',
        'transcription',
        'speaker_id',
      ].sort(),
    );
    expect(capRows.every((c) => c.userId === DEFAULT_USER_ID)).toBe(true);

    // The three deepseek capabilities all point at the single shared connection.
    const deepseekCapProviderIds = new Set(
      capRows
        .filter((c) => ['summarization', 'entity_extraction', 'tasks'].includes(c.capability))
        .map((c) => c.providerId),
    );
    expect(deepseekCapProviderIds).toEqual(new Set([deepseek[0].id]));

    // transcription/speaker_id imported with their protocols + keys.
    const transcription = providerRows.find((p) => p.protocol === 'elevenlabs');
    expect(decryptSecret(transcription?.apiKeyEncrypted as string, SECRET)).toBe('eleven-key');
    const diarization = providerRows.find((p) => p.protocol === 'pyannoteai');
    expect(decryptSecret(diarization?.apiKeyEncrypted as string, SECRET)).toBe('pyannote-key');
  });

  it('is idempotent — a second run adds no duplicate rows', async () => {
    process.env.SUMMARIZATION_API_KEY = 'deepseek-key';
    process.env.EMBEDDINGS_API_KEY = 'openai-embed-key';

    await service.onModuleInit();
    const providersAfterFirst = await providers.count();
    const capsAfterFirst = await capabilities.count();
    expect(providersAfterFirst).toBeGreaterThan(0);

    await service.onModuleInit();
    expect(await providers.count()).toBe(providersAfterFirst);
    expect(await capabilities.count()).toBe(capsAfterFirst);
  });
});

import type { ConfigService } from '@nestjs/config';
import {
  buildUserPrompt,
  OpenAiEntityExtractionProvider,
  parseEntitiesResponse,
  SYSTEM_PROMPT,
} from './openai.provider';
import type { EntityExtractionInput } from '../entities.provider';

/** Minimal ConfigService stand-in — the provider only ever calls `.get(key, default)`. */
function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

// Auditing is exercised in the audit lib's own spec; here it is a no-op stub.
const audit = { record: async () => undefined } as any;

const minimalInput: EntityExtractionInput = { text: 'hello' };

const baseInput: EntityExtractionInput = {
  text: 'Angela met Bob in Berlin.',
  language: 'en',
  occurredAt: '2026-07-01T10:00:00Z',
};

describe('buildUserPrompt', () => {
  it('embeds the transcript', () => {
    expect(buildUserPrompt(baseInput)).toContain('Angela met Bob in Berlin.');
  });

  it('includes the recording metadata when present', () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain('language: en');
    expect(prompt).toContain('recorded at: 2026-07-01T10:00:00Z');
  });

  it('omits the metadata line when nothing is known', () => {
    expect(buildUserPrompt(minimalInput)).not.toContain('Recording metadata');
  });
});

describe('parseEntitiesResponse', () => {
  it('parses a clean JSON object', () => {
    const out = parseEntitiesResponse(
      JSON.stringify({
        entities: [
          { type: 'person', name: 'Angela Merkel', mentions: ['Angela'] },
          { type: 'place', name: 'Berlin', mentions: [] },
        ],
      }),
    );
    expect(out).toEqual([
      { type: 'person', name: 'Angela Merkel', mentions: ['Angela'] },
      { type: 'place', name: 'Berlin', mentions: [] },
    ]);
  });

  it('tolerates a ```json code fence', () => {
    const out = parseEntitiesResponse(
      '```json\n{"entities":[{"type":"organization","name":"CDU"}]}\n```',
    );
    expect(out).toEqual([{ type: 'organization', name: 'CDU', mentions: [] }]);
  });

  it('drops entries with an unknown type or empty name', () => {
    const out = parseEntitiesResponse(
      JSON.stringify({
        entities: [
          { type: 'alien', name: 'Zorp' },
          { type: 'person', name: '  ' },
          { type: 'person', name: 'Valid' },
        ],
      }),
    );
    expect(out).toEqual([{ type: 'person', name: 'Valid', mentions: [] }]);
  });

  it('drops entities whose name is a pronoun or generic role noun', () => {
    const out = parseEntitiesResponse(
      JSON.stringify({
        entities: [
          { type: 'person', name: 'Sie' },
          { type: 'person', name: 'der Patient' },
          { type: 'person', name: 'Jan Jaap' },
        ],
      }),
    );
    expect(out).toEqual([{ type: 'person', name: 'Jan Jaap', mentions: [] }]);
  });

  it('returns an empty array for a missing/empty entities field', () => {
    expect(parseEntitiesResponse(JSON.stringify({ entities: [] }))).toEqual([]);
    expect(parseEntitiesResponse(JSON.stringify({}))).toEqual([]);
  });

  it('recovers a JSON object embedded in surrounding prose', () => {
    const out = parseEntitiesResponse(
      'Sure: {"entities":[{"type":"amount","name":"400mg"}]} — done',
    );
    expect(out).toEqual([{ type: 'amount', name: '400mg', mentions: [] }]);
  });

  it('throws on non-JSON content', () => {
    expect(() => parseEntitiesResponse('not json at all')).toThrow();
  });
});

describe('OpenAiEntityExtractionProvider.enabled', () => {
  it('is disabled with neither an API key nor ENTITY_EXTRACTION_ENABLED', () => {
    expect(new OpenAiEntityExtractionProvider(fakeConfig({}), audit).enabled).toBe(false);
  });

  it('is enabled when ENTITY_EXTRACTION_API_KEY is set (cloud default)', () => {
    const provider = new OpenAiEntityExtractionProvider(
      fakeConfig({ ENTITY_EXTRACTION_API_KEY: 'sk-test' }),
      audit,
    );
    expect(provider.enabled).toBe(true);
  });

  it('is enabled via ENTITY_EXTRACTION_ENABLED=true even without a key (keyless local servers e.g. Ollama)', () => {
    const provider = new OpenAiEntityExtractionProvider(
      fakeConfig({ ENTITY_EXTRACTION_ENABLED: 'true' }),
      audit,
    );
    expect(provider.enabled).toBe(true);
  });

  it('throws a descriptive error from extract() when disabled', async () => {
    const provider = new OpenAiEntityExtractionProvider(fakeConfig({}), audit);
    await expect(provider.extract(minimalInput)).rejects.toThrow(/ENTITY_EXTRACTION_ENABLED/);
  });
});

describe('OpenAiEntityExtractionProvider request behavior', () => {
  afterEach(() => jest.restoreAllMocks());

  it('omits the Authorization header when no API key is configured (e.g. Ollama)', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.1',
        choices: [
          { message: { content: JSON.stringify({ entities: [{ type: 'person', name: 'Bob' }] }) } },
        ],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiEntityExtractionProvider(
      fakeConfig({
        ENTITY_EXTRACTION_ENABLED: 'true',
        ENTITY_EXTRACTION_BASE_URL: 'http://localhost:11434/v1',
        ENTITY_EXTRACTION_MODEL: 'llama3.1',
      }),
      audit,
    );
    const result = await provider.extract(minimalInput);

    expect(result.entities).toEqual([{ type: 'person', name: 'Bob', mentions: [] }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the Authorization header when an API key is configured', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ message: { content: JSON.stringify({ entities: [] }) } }],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiEntityExtractionProvider(
      fakeConfig({ ENTITY_EXTRACTION_API_KEY: 'sk-test' }),
      audit,
    );
    await provider.extract(minimalInput);

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });
});

describe('SYSTEM_PROMPT', () => {
  it('enumerates every registry entity type', () => {
    for (const type of [
      'person',
      'organization',
      'place',
      'product',
      'medication',
      'document_reference',
    ]) {
      expect(SYSTEM_PROMPT).toContain(type);
    }
  });

  it('tells the model not to extract transient dates or amounts', () => {
    expect(SYSTEM_PROMPT).toMatch(/Do NOT extract standalone dates/i);
    expect(SYSTEM_PROMPT).toMatch(/amounts\/quantities/i);
  });
});

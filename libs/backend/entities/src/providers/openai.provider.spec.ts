import type { AiConfigService, ResolvedAiConfig } from '@plaudern/ai-config';
import { OpenAiChatClient } from '@plaudern/ai-config';
import {
  buildUserPrompt,
  OpenAiEntityExtractionProvider,
  parseEntitiesResponse,
  SYSTEM_PROMPT,
} from './openai.provider';
import type { EntityExtractionInput } from '../entities.provider';

const USER = 'user-1';

/** A ready-to-use resolved config for the entity_extraction capability. */
function resolved(overrides: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig {
  return {
    capability: 'entity_extraction',
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    apiKey: null,
    model: 'llama3.1',
    timeoutMs: 30000,
    params: {},
    providerId: 'p1',
    providerName: 'test',
    ...overrides,
  };
}

/** Minimal AiConfigService stand-in — resolve/isEnabled/invalidate is all the provider touches. */
function fakeAiConfig(cfg: ResolvedAiConfig | null): AiConfigService {
  return {
    resolve: async () => cfg,
    isEnabled: async () => cfg !== null,
    invalidate() {},
  } as unknown as AiConfigService;
}

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

describe('OpenAiEntityExtractionProvider without a resolved config', () => {
  it('throws a descriptive error from extract() when the capability is unconfigured', async () => {
    const provider = new OpenAiEntityExtractionProvider(fakeAiConfig(null), new OpenAiChatClient());
    await expect(provider.extract(USER, minimalInput)).rejects.toThrow(/entity_extraction/);
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
      fakeAiConfig(resolved({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: null })),
      new OpenAiChatClient(),
    );
    const result = await provider.extract(USER, minimalInput);

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
      fakeAiConfig(resolved({ apiKey: 'sk-test' })),
      new OpenAiChatClient(),
    );
    await provider.extract(USER, minimalInput);

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

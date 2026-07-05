import {
  AiConfigService,
  OpenAiEmbeddingsClient,
  type ResolvedAiConfig,
} from '@plaudern/ai-config';
import { OpenAiEmbeddingProvider } from './openai.provider';

const USER = 'user-1';

/** A ready-to-use resolved embeddings config; override per test. */
function cfg(over: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig {
  return {
    capability: 'embeddings',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'k',
    model: 'text-embedding-3-small',
    timeoutMs: 30000,
    params: {},
    providerId: 'p1',
    providerName: 'test',
    ...over,
  };
}

/** Fake AiConfigService: `resolve` yields the given config (or null = disabled). */
function fakeAiConfig(config: ResolvedAiConfig | null): AiConfigService {
  return {
    resolve: async () => config,
    isEnabled: async () => config !== null,
    invalidate() {},
  } as unknown as AiConfigService;
}

function providerWith(config: ResolvedAiConfig | null): OpenAiEmbeddingProvider {
  return new OpenAiEmbeddingProvider(fakeAiConfig(config), new OpenAiEmbeddingsClient());
}

describe('OpenAiEmbeddingProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('is disabled when the embeddings capability resolves to null', async () => {
    expect(await providerWith(null).isEnabled(USER)).toBe(false);
  });

  it('is enabled when the embeddings capability resolves to a provider', async () => {
    expect(await providerWith(cfg()).isEnabled(USER)).toBe(true);
  });

  it('has a stable provider id', () => {
    expect(providerWith(cfg()).id).toBe('openai');
  });

  it('throws a descriptive error (without calling the API) when embedding while unconfigured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(providerWith(null).embed(USER, ['x'])).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits the Authorization header when no API key is configured (e.g. Ollama)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'nomic-embed-text',
        data: [{ index: 0, embedding: [0.1, 0.2] }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = providerWith(
      cfg({
        apiKey: null,
        baseUrl: 'http://localhost:11434/v1',
        model: 'nomic-embed-text',
        params: { dimensions: 2 },
      }),
    );
    const out = await provider.embed(USER, ['hello']);

    expect(out.vectors).toEqual([[0.1, 0.2]]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/embeddings');
    expect(
      ((init as RequestInit).headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it('short-circuits an empty batch without hitting the network', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await providerWith(cfg()).embed(USER, []);
    expect(out.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the batch and returns vectors in response order', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'text-embedding-3-small',
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = providerWith(cfg({ params: { dimensions: 2 } }));
    const out = await provider.embed(USER, ['first', 'second']);

    expect(out.vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(out.dimensions).toBe(2);
    expect(out.model).toBe('text-embedding-3-small');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input).toEqual(['first', 'second']);
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer k' });
  });

  it('throws when the response has the wrong number of vectors', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }),
    }) as unknown as typeof fetch;
    await expect(providerWith(cfg()).embed(USER, ['a', 'b'])).rejects.toThrow('shape mismatch');
  });

  it('throws with the status on a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }) as unknown as typeof fetch;
    await expect(providerWith(cfg()).embed(USER, ['a'])).rejects.toThrow('429');
  });
});

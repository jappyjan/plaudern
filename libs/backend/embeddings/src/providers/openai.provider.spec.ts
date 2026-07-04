import { ConfigService } from '@nestjs/config';
import { OpenAiEmbeddingProvider } from './openai.provider';

function providerWith(env: Record<string, string>): OpenAiEmbeddingProvider {
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
  } as unknown as ConfigService;
  return new OpenAiEmbeddingProvider(config);
}

describe('OpenAiEmbeddingProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('is disabled with neither an API key nor EMBEDDINGS_ENABLED', () => {
    expect(providerWith({}).enabled).toBe(false);
  });

  it('is enabled when EMBEDDINGS_API_KEY is set (cloud default)', () => {
    expect(providerWith({ EMBEDDINGS_API_KEY: 'k' }).enabled).toBe(true);
  });

  it('is enabled via EMBEDDINGS_ENABLED=true even without a key (keyless local servers e.g. Ollama)', () => {
    expect(providerWith({ EMBEDDINGS_ENABLED: 'true' }).enabled).toBe(true);
  });

  it('derives its id from the configured model', () => {
    expect(providerWith({ EMBEDDINGS_MODEL: 'my-model' }).id).toBe('openai:my-model');
  });

  it('throws a descriptive error (without calling the API) when embedding while disabled', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(providerWith({}).embed(['x'])).rejects.toThrow(/EMBEDDINGS_ENABLED/);
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

    const provider = providerWith({
      EMBEDDINGS_ENABLED: 'true',
      EMBEDDINGS_BASE_URL: 'http://localhost:11434/v1',
      EMBEDDINGS_MODEL: 'nomic-embed-text',
      EMBEDDINGS_DIMENSIONS: '2',
    });
    const out = await provider.embed(['hello']);

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
    const out = await providerWith({ EMBEDDINGS_API_KEY: 'k' }).embed([]);
    expect(out.vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the batch and returns vectors ordered by response index', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        model: 'text-embedding-3-small',
        // Deliberately out of order to prove we sort by `index`.
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = providerWith({ EMBEDDINGS_API_KEY: 'k', EMBEDDINGS_DIMENSIONS: '2' });
    const out = await provider.embed(['first', 'second']);

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
    await expect(
      providerWith({ EMBEDDINGS_API_KEY: 'k' }).embed(['a', 'b']),
    ).rejects.toThrow('shape mismatch');
  });

  it('throws with the status on a non-OK response', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    }) as unknown as typeof fetch;
    await expect(providerWith({ EMBEDDINGS_API_KEY: 'k' }).embed(['a'])).rejects.toThrow('429');
  });
});

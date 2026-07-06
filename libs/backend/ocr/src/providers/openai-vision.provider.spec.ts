import {
  AiConfigService,
  OpenAiChatClient,
  type ResolvedAiConfig,
} from '@plaudern/ai-config';
import { OpenAiVisionOcrProvider } from './openai-vision.provider';

const USER = 'user-1';
const IMAGE = 'data:image/png;base64,AAAA';

/** A ready-to-use resolved `ocr` config; override per test. */
function cfg(over: Partial<ResolvedAiConfig> = {}): ResolvedAiConfig {
  return {
    capability: 'ocr',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-vision',
    model: 'gpt-4o-mini',
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

function providerWith(config: ResolvedAiConfig | null): OpenAiVisionOcrProvider {
  return new OpenAiVisionOcrProvider(fakeAiConfig(config), new OpenAiChatClient({ record: async () => undefined } as any));
}

function okResponse(text: string, model = 'gpt-4o-mini') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ model, choices: [{ message: { content: text } }] }),
    text: async () => '',
  };
}

describe('OpenAiVisionOcrProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('throws a helpful error (without calling the API) when the ocr capability is unconfigured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      providerWith(null).recognize(USER, { imageDataUrl: IMAGE, contentType: 'image/png' }),
    ).rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the image as an image_url and returns the transcribed text', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse('  hello world  '));
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await providerWith(cfg()).recognize(USER, {
      imageDataUrl: IMAGE,
      contentType: 'image/png',
    });

    expect(out.text).toBe('hello world');
    expect(out.model).toBe('gpt-4o-mini');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse((init as RequestInit).body as string);
    const imagePart = body.messages[1].content.find(
      (p: { type: string }) => p.type === 'image_url',
    );
    expect(imagePart.image_url.url).toBe(IMAGE);
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk-vision' });
  });

  it('omits the Authorization header when the provider is keyless (local vision gateway)', async () => {
    const fetchMock = jest.fn().mockResolvedValue(okResponse('text', 'llava'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await providerWith(
      cfg({ apiKey: null, baseUrl: 'http://localhost:11434/v1', model: 'llava' }),
    ).recognize(USER, { imageDataUrl: IMAGE, contentType: 'image/png' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(
      ((init as RequestInit).headers as Record<string, string>).authorization,
    ).toBeUndefined();
  });

  it('surfaces a non-OK response as an error', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'model is not vision-capable',
    }) as unknown as typeof fetch;
    await expect(
      providerWith(cfg()).recognize(USER, { imageDataUrl: IMAGE, contentType: 'image/png' }),
    ).rejects.toThrow('400');
  });
});

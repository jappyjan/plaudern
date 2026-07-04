import type { ConfigService } from '@nestjs/config';
import {
  buildUserPrompt,
  OpenAiSummarizationProvider,
  parseSummaryResponse,
  SYSTEM_PROMPT,
} from './openai.provider';
import type { SummarizationInput } from '../summarization.provider';

/** Minimal ConfigService stand-in — the provider only ever calls `.get(key, default)`. */
function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
  } as unknown as ConfigService;
}

const minimalInput: SummarizationInput = {
  transcript: 'hello',
  speakers: [],
};

const baseInput: SummarizationInput = {
  transcript: 'SPEAKER_00: hello there\nSPEAKER_01: hi',
  speakers: [
    { label: 'SPEAKER_00', displayName: 'Alex', confirmed: true },
    { label: 'SPEAKER_01', displayName: 'Speaker 2', confirmed: false },
  ],
  language: 'en',
};

describe('buildUserPrompt', () => {
  it('lists every layout option', () => {
    const prompt = buildUserPrompt(baseInput);
    for (const layout of ['meeting', 'interview', 'lecture', 'conversation', 'note', 'todo', 'general']) {
      expect(prompt).toContain(`- ${layout}:`);
    }
  });

  it('includes the speaker roster with labels, names and confirmation', () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain('SPEAKER_00 = Alex');
    expect(prompt).toContain('SPEAKER_01 = Speaker 2 (unconfirmed)');
  });

  it('embeds the transcript', () => {
    expect(buildUserPrompt(baseInput)).toContain('SPEAKER_00: hello there');
  });

  it('omits the roster section when there are no speakers', () => {
    const prompt = buildUserPrompt({ ...baseInput, speakers: [] });
    expect(prompt).not.toContain('Speaker roster');
  });

  it("defaults to the transcript's own language when no target is set", () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain("in the transcript's own language");
  });

  it('forces the configured output language when one is set', () => {
    const prompt = buildUserPrompt({ ...baseInput, targetLanguage: 'German' });
    expect(prompt).toContain('in German, regardless of the transcript');
  });
});

describe('parseSummaryResponse', () => {
  it('parses a clean JSON object', () => {
    const out = parseSummaryResponse(
      JSON.stringify({ title: 'Weekly sync', layout: 'meeting', markdown: '## Notes\n- a' }),
    );
    expect(out).toEqual({
      title: 'Weekly sync',
      layout: 'meeting',
      markdown: '## Notes\n- a',
      offTopic: null,
    });
  });

  it('tolerates a ```json code fence', () => {
    const out = parseSummaryResponse(
      '```json\n{"title":"T","layout":"note","markdown":"body"}\n```',
    );
    expect(out.layout).toBe('note');
    expect(out.markdown).toBe('body');
  });

  it('falls back to the "general" layout for an unknown value', () => {
    const out = parseSummaryResponse(
      JSON.stringify({ title: 'T', layout: 'nonsense', markdown: 'body' }),
    );
    expect(out.layout).toBe('general');
  });

  it('supplies a default title when missing', () => {
    const out = parseSummaryResponse(JSON.stringify({ layout: 'note', markdown: 'body' }));
    expect(out.title).toBe('Untitled recording');
  });

  it('throws when there is no markdown body', () => {
    expect(() => parseSummaryResponse(JSON.stringify({ title: 'T', layout: 'note' }))).toThrow();
  });

  it('throws on non-JSON content', () => {
    expect(() => parseSummaryResponse('not json at all')).toThrow();
  });

  it('recovers a JSON object embedded in surrounding prose', () => {
    const out = parseSummaryResponse(
      'Here you go: {"title":"T","layout":"todo","markdown":"- [ ] x"} — done',
    );
    expect(out.layout).toBe('todo');
  });

  it('passes an offTopic string through', () => {
    const out = parseSummaryResponse(
      JSON.stringify({
        title: 'T',
        layout: 'meeting',
        markdown: 'body',
        offTopic: '- weather chat',
      }),
    );
    expect(out.offTopic).toBe('- weather chat');
  });

  it('coerces a null, missing, blank or non-string offTopic to null', () => {
    const base = { title: 'T', layout: 'note', markdown: 'body' };
    for (const offTopic of [null, undefined, '  \n', 42]) {
      const out = parseSummaryResponse(JSON.stringify({ ...base, offTopic }));
      expect(out.offTopic).toBeNull();
    }
  });
});

describe('OpenAiSummarizationProvider.enabled', () => {
  it('is disabled with neither an API key nor SUMMARIZATION_ENABLED', () => {
    expect(new OpenAiSummarizationProvider(fakeConfig({})).enabled).toBe(false);
  });

  it('is enabled when SUMMARIZATION_API_KEY is set (cloud default)', () => {
    const provider = new OpenAiSummarizationProvider(
      fakeConfig({ SUMMARIZATION_API_KEY: 'sk-test' }),
    );
    expect(provider.enabled).toBe(true);
  });

  it('is enabled via SUMMARIZATION_ENABLED=true even without a key (keyless local servers e.g. Ollama)', () => {
    const provider = new OpenAiSummarizationProvider(
      fakeConfig({ SUMMARIZATION_ENABLED: 'true' }),
    );
    expect(provider.enabled).toBe(true);
  });

  it('throws a descriptive error from summarize() when disabled', async () => {
    const provider = new OpenAiSummarizationProvider(fakeConfig({}));
    await expect(provider.summarize(minimalInput)).rejects.toThrow(/SUMMARIZATION_ENABLED/);
  });
});

describe('OpenAiSummarizationProvider request behavior', () => {
  afterEach(() => jest.restoreAllMocks());

  it('omits the Authorization header when no API key is configured (e.g. Ollama)', async () => {
    const fetchMock = jest.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.1',
        choices: [{ message: { content: JSON.stringify({ title: 'T', layout: 'note', markdown: 'body' }) } }],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiSummarizationProvider(
      fakeConfig({
        SUMMARIZATION_ENABLED: 'true',
        SUMMARIZATION_BASE_URL: 'http://localhost:11434/v1',
        SUMMARIZATION_MODEL: 'llama3.1',
      }),
    );
    const result = await provider.summarize(minimalInput);

    expect(result.markdown).toBe('body');
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
        choices: [{ message: { content: JSON.stringify({ title: 'T', layout: 'note', markdown: 'body' }) } }],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiSummarizationProvider(
      fakeConfig({ SUMMARIZATION_API_KEY: 'sk-test' }),
    );
    await provider.summarize(minimalInput);

    const [, init] = fetchMock.mock.calls[0];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });
});

describe('SYSTEM_PROMPT', () => {
  it('instructs the model to separate off-topic tangents into "offTopic"', () => {
    expect(SYSTEM_PROMPT).toContain('"offTopic"');
    expect(SYSTEM_PROMPT).toContain('Off-topic rules:');
  });
});

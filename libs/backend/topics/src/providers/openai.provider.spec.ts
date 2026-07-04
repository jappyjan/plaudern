import type { ConfigService } from '@nestjs/config';
import {
  buildUserPrompt,
  OpenAiTopicClassificationProvider,
  parseClassificationResponse,
  SYSTEM_PROMPT,
} from './openai.provider';
import type { TopicClassificationInput } from '../topics.provider';

/** Minimal ConfigService stand-in — the provider only ever calls `.get(key, default)`. */
function fakeConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string, defaultValue?: unknown) => (key in values ? values[key] : defaultValue),
  } as unknown as ConfigService;
}

const TOPIC_A = '11111111-1111-1111-1111-111111111111';
const TOPIC_B = '22222222-2222-2222-2222-222222222222';

const baseInput: TopicClassificationInput = {
  content: 'We poured the foundation and picked the roof tiles for the new house.',
  topics: [
    { id: TOPIC_A, name: 'Hausbau', description: 'Building our house' },
    { id: TOPIC_B, name: 'Work', description: null },
  ],
  language: 'en',
};

describe('buildUserPrompt', () => {
  it('lists every taxonomy entry by id and name', () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain(`id: ${TOPIC_A} | Hausbau — Building our house`);
    expect(prompt).toContain(`id: ${TOPIC_B} | Work`);
  });

  it('omits the description separator when a topic has none', () => {
    const prompt = buildUserPrompt(baseInput);
    expect(prompt).toContain(`id: ${TOPIC_B} | Work\n`);
    expect(prompt).not.toContain(`${TOPIC_B} | Work —`);
  });

  it('embeds the note content', () => {
    expect(buildUserPrompt(baseInput)).toContain('poured the foundation');
  });

  it('includes the language hint when provided', () => {
    expect(buildUserPrompt(baseInput)).toContain('Note language: en.');
  });
});

describe('parseClassificationResponse', () => {
  const valid = [TOPIC_A, TOPIC_B];

  it('parses a clean JSON object', () => {
    const out = parseClassificationResponse(
      JSON.stringify({ assignments: [{ id: TOPIC_A, confidence: 0.9 }] }),
      valid,
    );
    expect(out).toEqual([{ topicId: TOPIC_A, confidence: 0.9 }]);
  });

  it('tolerates a ```json code fence', () => {
    const out = parseClassificationResponse(
      `\`\`\`json\n{"assignments":[{"id":"${TOPIC_B}","confidence":0.5}]}\n\`\`\``,
      valid,
    );
    expect(out).toEqual([{ topicId: TOPIC_B, confidence: 0.5 }]);
  });

  it('drops ids that are not in the taxonomy', () => {
    const out = parseClassificationResponse(
      JSON.stringify({
        assignments: [
          { id: TOPIC_A, confidence: 0.8 },
          { id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', confidence: 0.99 },
        ],
      }),
      valid,
    );
    expect(out).toEqual([{ topicId: TOPIC_A, confidence: 0.8 }]);
  });

  it('clamps confidence into [0, 1]', () => {
    const out = parseClassificationResponse(
      JSON.stringify({
        assignments: [
          { id: TOPIC_A, confidence: 1.7 },
          { id: TOPIC_B, confidence: -3 },
        ],
      }),
      valid,
    );
    expect(out).toEqual([
      { topicId: TOPIC_A, confidence: 1 },
      { topicId: TOPIC_B, confidence: 0 },
    ]);
  });

  it('dedupes on topic id, keeping the highest confidence', () => {
    const out = parseClassificationResponse(
      JSON.stringify({
        assignments: [
          { id: TOPIC_A, confidence: 0.3 },
          { id: TOPIC_A, confidence: 0.7 },
        ],
      }),
      valid,
    );
    expect(out).toEqual([{ topicId: TOPIC_A, confidence: 0.7 }]);
  });

  it('defaults a missing confidence to a firm 1', () => {
    const out = parseClassificationResponse(JSON.stringify({ assignments: [{ id: TOPIC_A }] }), valid);
    expect(out).toEqual([{ topicId: TOPIC_A, confidence: 1 }]);
  });

  it('returns an empty array for an empty or missing assignments list', () => {
    expect(parseClassificationResponse(JSON.stringify({ assignments: [] }), valid)).toEqual([]);
    expect(parseClassificationResponse(JSON.stringify({}), valid)).toEqual([]);
  });

  it('returns an empty array (never throws) on non-JSON content', () => {
    expect(parseClassificationResponse('not json at all', valid)).toEqual([]);
  });

  it('recovers a JSON object embedded in surrounding prose', () => {
    const out = parseClassificationResponse(
      `Sure: {"assignments":[{"id":"${TOPIC_A}","confidence":0.6}]} — done`,
      valid,
    );
    expect(out).toEqual([{ topicId: TOPIC_A, confidence: 0.6 }]);
  });
});

describe('OpenAiTopicClassificationProvider.enabled', () => {
  it('is disabled with neither an API key nor TOPICS_ENABLED', () => {
    expect(new OpenAiTopicClassificationProvider(fakeConfig({})).enabled).toBe(false);
  });

  it('is enabled when TOPICS_API_KEY is set (cloud default)', () => {
    expect(
      new OpenAiTopicClassificationProvider(fakeConfig({ TOPICS_API_KEY: 'sk-test' })).enabled,
    ).toBe(true);
  });

  it('is enabled via TOPICS_ENABLED=true even without a key (keyless local servers)', () => {
    expect(
      new OpenAiTopicClassificationProvider(fakeConfig({ TOPICS_ENABLED: 'true' })).enabled,
    ).toBe(true);
  });

  it('throws a descriptive error from classify() when disabled', async () => {
    const provider = new OpenAiTopicClassificationProvider(fakeConfig({}));
    await expect(provider.classify(baseInput)).rejects.toThrow(/TOPICS_ENABLED/);
  });
});

describe('OpenAiTopicClassificationProvider request behavior', () => {
  afterEach(() => jest.restoreAllMocks());

  it('omits the Authorization header when no API key is configured (e.g. Ollama)', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama3.1',
        choices: [{ message: { content: JSON.stringify({ assignments: [{ id: TOPIC_A, confidence: 1 }] }) } }],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiTopicClassificationProvider(
      fakeConfig({
        TOPICS_ENABLED: 'true',
        TOPICS_BASE_URL: 'http://localhost:11434/v1',
        TOPICS_MODEL: 'llama3.1',
      }),
    );
    const result = await provider.classify(baseInput);

    expect(result.assignments).toEqual([{ topicId: TOPIC_A, confidence: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the Authorization header when an API key is configured', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'deepseek-chat',
        choices: [{ message: { content: JSON.stringify({ assignments: [] }) } }],
      }),
      text: async () => '',
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAiTopicClassificationProvider(fakeConfig({ TOPICS_API_KEY: 'sk-test' }));
    await provider.classify(baseInput);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });
});

describe('SYSTEM_PROMPT', () => {
  it('instructs the model to use only taxonomy ids and return an assignments array', () => {
    expect(SYSTEM_PROMPT).toContain('"assignments"');
    expect(SYSTEM_PROMPT).toContain('never invent an id');
  });
});

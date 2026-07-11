import type { ConfigService } from '@nestjs/config';
import type { AiAuditRecorder } from '@plaudern/audit';
import { OpenAiSentinelProvider } from './openai.provider';
import type { SentinelClassifyInput } from '../sentinel.provider';

/** A ConfigService fake reading from a plain map, with get(key, default) semantics. */
function makeConfig(env: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, fallback?: string) => (key in env ? env[key] : fallback),
  } as unknown as ConfigService;
}

function makeAudit(): AiAuditRecorder & { record: jest.Mock } {
  return { record: jest.fn().mockResolvedValue(undefined) } as never;
}

const OK_RESPONSE = {
  ok: true,
  json: async () => ({ model: 'test', choices: [{ message: { content: '{"tier":"normal","findings":[]}' } }] }),
  text: async () => '',
};

function input(over: Partial<SentinelClassifyInput> = {}): SentinelClassifyInput {
  return { transcript: 'some scanned text', ...over };
}

describe('OpenAiSentinelProvider (JJ-86 footgun guard)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('is disabled by default (no key, not explicitly enabled)', () => {
    const provider = new OpenAiSentinelProvider(makeConfig(), makeAudit());
    expect(provider.enabled).toBe(false);
  });

  it('REFUSES document-derived text against the default (external) endpoint — no network call', async () => {
    // Explicitly enabled but base URL left at the EXTERNAL default (the footgun).
    const audit = makeAudit();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    const provider = new OpenAiSentinelProvider(
      makeConfig({ SENTINEL_LLM_ENABLED: 'true' }),
      audit,
    );
    expect(provider.enabled).toBe(true);

    await expect(provider.classify(input({ documentDerived: true }))).rejects.toThrow(
      /non-local endpoint/,
    );
    // The raw document text never left the box: no audit record, no fetch.
    expect(audit.record).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('REFUSES ordinary (non-document) transcripts against an external endpoint too — no raw text off-box', async () => {
    const audit = makeAudit();
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as never;
    // Enabled via API key, base URL left at the external default.
    const provider = new OpenAiSentinelProvider(
      makeConfig({ SENTINEL_LLM_API_KEY: 'sk-test' }),
      audit,
    );
    expect(provider.enabled).toBe(true);

    await expect(provider.classify(input({ documentDerived: false }))).rejects.toThrow(
      /non-local endpoint/,
    );
    // A plain transcript is raw pre-tier content too — it must not leave the box.
    expect(audit.record).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ALLOWS document-derived text when the endpoint is validated-local', async () => {
    const audit = makeAudit();
    const fetchSpy = jest.fn().mockResolvedValue(OK_RESPONSE);
    global.fetch = fetchSpy as never;
    const provider = new OpenAiSentinelProvider(
      makeConfig({ SENTINEL_LLM_ENABLED: 'true', SENTINEL_LLM_BASE_URL: 'http://localhost:11434/v1' }),
      audit,
    );

    const result = await provider.classify(input({ documentDerived: true }));
    expect(result.tier).toBe('normal');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The call went to the local endpoint.
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('ALLOWS ordinary transcripts against a validated-local endpoint', async () => {
    const audit = makeAudit();
    const fetchSpy = jest.fn().mockResolvedValue(OK_RESPONSE);
    global.fetch = fetchSpy as never;
    const provider = new OpenAiSentinelProvider(
      makeConfig({ SENTINEL_LLM_ENABLED: 'true', SENTINEL_LLM_BASE_URL: 'http://ollama:11434/v1' }),
      audit,
    );

    const result = await provider.classify(input({ documentDerived: false }));
    expect(result.tier).toBe('normal');
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

import { PyannoteAiClient } from './pyannoteai-client';

/** Queue of canned responses; each fetch call shifts one off. */
function fakeFetch(responses: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as Response;
  });
  return { fn, calls };
}

function client() {
  // pollInterval 0 so the running->succeeded poll loop doesn't add wall time.
  return new PyannoteAiClient('https://api.test/v1', 'key', 'precision-2', 0, 10_000);
}

describe('PyannoteAiClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('submits a diarize job, polls until succeeded, and parses segments', async () => {
    const { fn, calls } = fakeFetch([
      { body: { jobId: 'j1' } },
      { body: { status: 'running' } },
      {
        body: {
          status: 'succeeded',
          output: { diarization: [{ start: 0, end: 2, speaker: 'SPEAKER_00' }] },
        },
      },
    ]);
    global.fetch = fn as unknown as typeof fetch;

    const result = await client().diarize('https://audio');

    expect(result.segments).toEqual([{ start: 0, end: 2, speaker: 'SPEAKER_00' }]);
    expect(result.durationSeconds).toBe(2);
    expect(calls[0].url).toBe('https://api.test/v1/diarize');
    expect(calls[0].init?.headers).toMatchObject({ authorization: 'Bearer key' });
    expect(calls[2].url).toBe('https://api.test/v1/jobs/j1');
  });

  it('sends voiceprints + threshold on identify and reads output.identification', async () => {
    const { fn, calls } = fakeFetch([
      { body: { jobId: 'j2' } },
      {
        body: {
          status: 'succeeded',
          output: { identification: [{ start: 1, end: 3, speaker: 'alice' }] },
        },
      },
    ]);
    global.fetch = fn as unknown as typeof fetch;

    const result = await client().identify(
      'https://audio',
      [{ label: 'alice', voiceprint: 'vp' }],
      0.5,
    );

    expect(result.segments).toEqual([{ start: 1, end: 3, speaker: 'alice' }]);
    const body = JSON.parse((calls[0].init?.body as string) ?? '{}');
    expect(body.voiceprints).toEqual([{ label: 'alice', voiceprint: 'vp' }]);
    expect(body.matching).toEqual({ exclusive: true, threshold: 0.5 });
  });

  it('returns the voiceprint token from a voiceprint job', async () => {
    const { fn } = fakeFetch([
      { body: { jobId: 'j3' } },
      { body: { status: 'succeeded', output: { voiceprint: 'VP_TOKEN' } } },
    ]);
    global.fetch = fn as unknown as typeof fetch;

    expect(await client().voiceprint('https://clip')).toBe('VP_TOKEN');
  });

  it('throws when a job fails', async () => {
    const { fn } = fakeFetch([
      { body: { jobId: 'j4' } },
      { body: { status: 'failed', error: 'bad audio' } },
    ]);
    global.fetch = fn as unknown as typeof fetch;

    await expect(client().diarize('https://audio')).rejects.toThrow(/failed.*bad audio/);
  });

  it('throws on a non-2xx submit', async () => {
    const { fn } = fakeFetch([{ ok: false, status: 402, body: { message: 'no credits' } }]);
    global.fetch = fn as unknown as typeof fetch;

    await expect(client().diarize('https://audio')).rejects.toThrow(/402/);
  });
});

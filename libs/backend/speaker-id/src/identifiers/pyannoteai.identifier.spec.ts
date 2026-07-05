import { Readable } from 'node:stream';
import { PyannoteAiSpeakerIdentifier } from './pyannoteai.identifier';
import { PyannoteAiClient } from '../providers/pyannoteai-client';
import type { PyannoteAiDiarization } from '../providers/pyannoteai-client';
import type { AiConfigService, ResolvedAiConfig } from '@plaudern/ai-config';
import type { VoiceprintMatcherService, DiarizedSpeakerLite } from '../voiceprint-matcher.service';

// Audio is read from private storage and pushed to pyannoteAI — never presigned.
const storage = { getObjectStream: async () => Readable.from([Buffer.from('AUDIO')]) } as any;

/** A resolved speaker_id config; the identifier builds its client from this. */
const cfg: ResolvedAiConfig = {
  capability: 'speaker_id',
  protocol: 'pyannoteai',
  baseUrl: 'https://api.test/v1',
  apiKey: 'key',
  model: 'precision-2',
  timeoutMs: 10_000,
  params: {
    matchThreshold: 50,
    minEnrollSeconds: 6,
    voiceprintMaxSeconds: 30,
    pollIntervalMs: 0,
  },
  providerId: 'p1',
  providerName: 'test',
};

const job = {
  userId: 'u1',
  inboxItemId: 'item-1',
  extractionId: 'ext-1',
  storageKey: 'audio/1',
  contentType: 'audio/mp4',
};

function build(known: { id: string; voiceprint: string | null }[]) {
  const aiConfig = {
    resolve: async () => cfg,
    isEnabled: async () => true,
    invalidate() {},
  } as unknown as AiConfigService;
  const captured: { speakers?: DiarizedSpeakerLite[] } = {};
  const matcher = {
    assignSpeakers: async (_job: unknown, speakers: DiarizedSpeakerLite[]) => {
      captured.speakers = speakers;
    },
  } as unknown as VoiceprintMatcherService;
  const profiles = { find: async () => known } as any;
  const clientCalls: string[] = [];
  const client = {
    upload: async () => 'media://uploaded',
    diarize: async (url: string) => {
      clientCalls.push(`diarize:${url}`);
      return diar;
    },
    identify: async (url: string) => {
      clientCalls.push(`identify:${url}`);
      return diar;
    },
  } as unknown as PyannoteAiClient;
  // The identifier builds its client via PyannoteAiClient.fromResolvedConfig;
  // hand it our fake so we can capture the diarize/identify calls.
  jest.spyOn(PyannoteAiClient, 'fromResolvedConfig').mockReturnValue(client);
  let diar: PyannoteAiDiarization = { durationSeconds: 0, segments: [] };
  const setDiar = (d: PyannoteAiDiarization) => (diar = d);
  const identifier = new PyannoteAiSpeakerIdentifier(aiConfig, storage, matcher, profiles);
  return { identifier, captured, clientCalls, setDiar };
}

describe('PyannoteAiSpeakerIdentifier', () => {
  afterEach(() => jest.restoreAllMocks());

  it('diarizes (no /identify) when there are no known voiceprints', async () => {
    const { identifier, captured, clientCalls, setDiar } = build([]);
    setDiar({
      durationSeconds: 5,
      segments: [
        { start: 0, end: 2, speaker: 'SPEAKER_00' },
        { start: 2, end: 5, speaker: 'SPEAKER_01' },
      ],
    });

    const result = await identifier.identify(job);

    // Uploaded to pyannoteAI's storage, then diarized off the media:// handle.
    expect(clientCalls).toEqual(['diarize:media://uploaded']);
    expect(captured.speakers?.map((s) => s.label)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(captured.speakers?.every((s) => s.matchedProfile === null)).toBe(true);
    expect(result.segments).toHaveLength(2);
  });

  it('identifies against known voiceprints and tags the matched speaker', async () => {
    const known = [{ id: 'profile-A', voiceprint: 'vpA' }];
    const { identifier, captured, clientCalls, setDiar } = build(known);
    // /identify reports the matched speaker under the voiceprint's label (profile id).
    setDiar({
      durationSeconds: 10,
      segments: [
        { start: 0, end: 4, speaker: 'profile-A' },
        { start: 4, end: 10, speaker: 'SPEAKER_99' },
      ],
    });

    const result = await identifier.identify(job);

    expect(clientCalls).toEqual(['identify:media://uploaded']);
    const speakers = captured.speakers ?? [];
    // Canonical relabeling in order of appearance, regardless of raw labels.
    expect(speakers.map((s) => s.label)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
    expect(speakers[0].matchedProfile?.id).toBe('profile-A');
    expect(speakers[0].speakingSeconds).toBeCloseTo(4);
    expect(speakers[1].matchedProfile).toBeNull();
    expect(speakers[1].speakingSeconds).toBeCloseTo(6);
    // Returned segments carry the canonical labels the matcher persisted.
    expect(result.segments.map((s) => s.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01']);
  });
});

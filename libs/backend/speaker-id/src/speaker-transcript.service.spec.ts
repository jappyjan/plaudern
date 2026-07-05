import type { Repository } from 'typeorm';
import type { TranscriptSpeakerDto } from '@plaudern/contracts';
import type {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import {
  attributeSegments,
  overlapSeconds,
  SpeakerTranscriptService,
} from './speaker-transcript.service';

const alice: TranscriptSpeakerDto = {
  profileId: 'p-alice',
  name: 'Alice',
  label: 'SPEAKER_00',
  status: 'confirmed',
  isSelf: false,
  consentStatus: 'consented',
};
const bob: TranscriptSpeakerDto = {
  profileId: 'p-bob',
  name: null,
  label: 'SPEAKER_01',
  status: 'unconfirmed',
  isSelf: false,
  consentStatus: 'unknown',
};
const speakerByLabel = new Map([
  ['SPEAKER_00', alice],
  ['SPEAKER_01', bob],
]);

describe('overlapSeconds', () => {
  it('sums overlap across windows and clamps at zero', () => {
    const windows = [
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ];
    expect(overlapSeconds(1, 6, windows)).toBeCloseTo(2);
    expect(overlapSeconds(3, 4, windows)).toBe(0);
  });
});

describe('attributeSegments', () => {
  const diarization = [
    { start: 0, end: 4, speaker: 'SPEAKER_00' },
    { start: 4, end: 8, speaker: 'SPEAKER_01' },
  ];

  it('assigns each transcript segment the speaker with max temporal overlap', () => {
    const result = attributeSegments(
      [
        { start: 0, end: 3, text: 'hello' },
        { start: 3, end: 7, text: 'world' },
      ],
      diarization,
      speakerByLabel,
    );
    expect(result).toHaveLength(2);
    expect(result[0].speaker).toEqual(alice);
    // 3-7 overlaps Alice by 1s and Bob by 3s.
    expect(result[1].speaker).toEqual(bob);
  });

  it('coalesces consecutive segments of the same speaker', () => {
    const result = attributeSegments(
      [
        { start: 0, end: 1, text: 'one ' },
        { start: 1, end: 2, text: ' two' },
        { start: 6, end: 7, text: 'three' },
      ],
      diarization,
      speakerByLabel,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ start: 0, end: 2, text: 'one two' });
    expect(result[1]).toMatchObject({ text: 'three', speaker: bob });
  });

  it('leaves segments without overlap unattributed and merges null runs', () => {
    const result = attributeSegments(
      [
        { start: 10, end: 11, text: 'silence?' },
        { start: 11, end: 12, text: 'still silent' },
      ],
      diarization,
      speakerByLabel,
    );
    expect(result).toHaveLength(1);
    expect(result[0].speaker).toBeNull();
  });
});

describe('SpeakerTranscriptService.getSpeakerTranscript', () => {
  function extraction(overrides: Partial<ExtractedPayloadEntity>): ExtractedPayloadEntity {
    return {
      id: 'ext-x',
      inboxItemId: 'item-1',
      kind: 'transcription',
      provider: 'stub',
      status: 'succeeded',
      content: null,
      contentStorageKey: null,
      segments: null,
      language: null,
      error: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      completedAt: null,
      ...overrides,
    } as ExtractedPayloadEntity;
  }

  function build(extractions: ExtractedPayloadEntity[], occurrences: SpeakerOccurrenceEntity[]) {
    const inbox = {
      getItem: jest.fn(async () => ({ id: 'item-1', extractions }) as unknown as InboxItemEntity),
    } as unknown as InboxService;
    const occurrenceRepo = {
      find: jest.fn(async ({ where }: { where: { extractionId: string } }) =>
        occurrences.filter((o) => o.extractionId === where.extractionId),
      ),
    } as unknown as Repository<SpeakerOccurrenceEntity>;
    return new SpeakerTranscriptService(inbox, occurrenceRepo);
  }

  const occurrence = {
    id: 'occ-1',
    extractionId: 'ext-d',
    inboxItemId: 'item-1',
    voiceProfileId: 'p-alice',
    label: 'SPEAKER_00',
    embedding: [1],
    speakingSeconds: 4,
    similarity: 0.9,
    voiceProfile: {
      id: 'p-alice',
      name: 'Alice',
      status: 'confirmed',
      isSelf: false,
      consentStatus: 'consented',
      redacted: false,
    },
  } as unknown as SpeakerOccurrenceEntity;

  it('returns segmented mode when transcript and diarization align', async () => {
    const service = build(
      [
        extraction({
          id: 'ext-t',
          content: 'hello world',
          segments: [{ start: 0, end: 4, text: 'hello world' }],
        }),
        extraction({
          id: 'ext-d',
          kind: 'diarization',
          segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }],
        }),
      ],
      [occurrence],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.mode).toBe('segmented');
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].speaker?.name).toBe('Alice');
    expect(result.speakers).toHaveLength(1);
    expect(result.diarizationStatus).toBe('succeeded');
  });

  it('flags an unknown-consent speaker for review', async () => {
    const unknownConsent = {
      ...occurrence,
      voiceProfile: { ...(occurrence.voiceProfile as object), consentStatus: 'unknown' },
    } as unknown as SpeakerOccurrenceEntity;
    const service = build(
      [
        extraction({
          id: 'ext-t',
          content: 'hello',
          segments: [{ start: 0, end: 4, text: 'hello' }],
        }),
        extraction({
          id: 'ext-d',
          kind: 'diarization',
          segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }],
        }),
      ],
      [unknownConsent],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.needsConsentReview).toBe(true);
    expect(result.speakers[0].consentStatus).toBe('unknown');
  });

  it('excludes a redacted speaker from segments and lists them separately', async () => {
    const redactedBob = {
      id: 'occ-2',
      extractionId: 'ext-d',
      inboxItemId: 'item-1',
      voiceProfileId: 'p-bob',
      label: 'SPEAKER_01',
      speakingSeconds: 4,
      similarity: 0.8,
      voiceProfile: {
        id: 'p-bob',
        name: 'Bob',
        status: 'confirmed',
        isSelf: false,
        consentStatus: 'declined',
        redacted: true,
      },
    } as unknown as SpeakerOccurrenceEntity;
    const service = build(
      [
        extraction({
          id: 'ext-t',
          content: 'hello there',
          segments: [
            { start: 0, end: 4, text: 'hello' },
            { start: 4, end: 8, text: 'there' },
          ],
        }),
        extraction({
          id: 'ext-d',
          kind: 'diarization',
          segments: [
            { start: 0, end: 4, speaker: 'SPEAKER_00' },
            { start: 4, end: 8, speaker: 'SPEAKER_01' },
          ],
        }),
      ],
      [occurrence, redactedBob],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.speakers.map((s) => s.profileId)).toEqual(['p-alice']);
    expect(result.redactedSpeakers.map((s) => s.profileId)).toEqual(['p-bob']);
    // Bob's segment ("there") is dropped; only Alice's remains.
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].speaker?.profileId).toBe('p-alice');
    expect(result.segments.some((s) => s.text.includes('there'))).toBe(false);
  });

  it('falls back to flat mode (with speaker chips) when the transcript has no segments', async () => {
    const service = build(
      [
        extraction({ id: 'ext-t', content: 'hello world' }),
        extraction({
          id: 'ext-d',
          kind: 'diarization',
          segments: [{ start: 0, end: 4, speaker: 'SPEAKER_00' }],
        }),
      ],
      [occurrence],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.mode).toBe('flat');
    expect(result.text).toBe('hello world');
    expect(result.speakers).toHaveLength(1);
  });

  it('reports in-flight diarization status without speakers', async () => {
    const service = build(
      [
        extraction({ id: 'ext-t', content: 'hello world' }),
        extraction({ id: 'ext-d', kind: 'diarization', status: 'processing' }),
      ],
      [],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.mode).toBe('flat');
    expect(result.speakers).toHaveLength(0);
    expect(result.diarizationStatus).toBe('processing');
  });

  it('returns none when there is no successful transcript', async () => {
    const service = build([extraction({ id: 'ext-t', status: 'failed' })], []);
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.mode).toBe('none');
    expect(result.text).toBeNull();
    expect(result.diarizationStatus).toBeNull();
  });

  it('uses the newest extraction of each kind', async () => {
    const service = build(
      [
        extraction({
          id: 'ext-old',
          content: 'old',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        extraction({
          id: 'ext-new',
          content: 'new',
          createdAt: new Date('2026-02-01T00:00:00Z'),
        }),
      ],
      [],
    );
    const result = await service.getSpeakerTranscript('u', 'item-1');
    expect(result.text).toBe('new');
  });
});

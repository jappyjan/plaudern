import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AiConfigService, ResolvedAiConfig } from '@plaudern/ai-config';
import type { SpeakerTranscriptDto } from '@plaudern/contracts';
import type { InboxService } from '@plaudern/inbox';
import type {
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { PyannoteAiClient } from './providers/pyannoteai-client';
import { SpeakerReassignmentService } from './speaker-reassignment.service';
import type { SpeakerTranscriptService } from './speaker-transcript.service';
import type { VoiceprintMatcherService } from './voiceprint-matcher.service';

const cfg = { capability: 'speaker_id' } as unknown as ResolvedAiConfig;
const transcript = { mode: 'segmented' } as unknown as SpeakerTranscriptDto;

function build(opts: {
  occurrence: Partial<SpeakerOccurrenceEntity> | null;
  enroll?: string | null;
  segments?: { start: number; end: number; speaker: string }[];
}) {
  const item = {
    id: 'item-1',
    source: { storageKey: 'audio/1' },
    extractions: [
      {
        id: 'ext-1',
        kind: 'diarization',
        status: 'succeeded',
        createdAt: new Date('2024-01-01'),
        segments: opts.segments ?? [{ start: 0, end: 10, speaker: 'SPEAKER_00' }],
      } as unknown as ExtractedPayloadEntity,
    ],
  } as unknown as InboxItemEntity;

  const inbox = { getItem: jest.fn(async () => item) } as unknown as InboxService;
  const aiConfig = { resolve: jest.fn(async () => cfg) } as unknown as AiConfigService;
  const matcher = {
    enrollVoiceprintForLabel: jest.fn(async () => opts.enroll ?? null),
  } as unknown as VoiceprintMatcherService;
  const transcripts = {
    getSpeakerTranscript: jest.fn(async () => transcript),
  } as unknown as SpeakerTranscriptService;

  const savedProfiles: VoiceProfileEntity[] = [];
  const profiles = {
    create: (data: Partial<VoiceProfileEntity>) => ({ ...data }) as VoiceProfileEntity,
    save: jest.fn(async (p: VoiceProfileEntity) => {
      p.id ??= 'new-profile';
      savedProfiles.push({ ...p });
      return p;
    }),
  } as unknown as Repository<VoiceProfileEntity>;

  const occurrence = opts.occurrence
    ? ({ id: 'occ-1', ...opts.occurrence } as SpeakerOccurrenceEntity)
    : null;
  const occurrences = {
    findOne: jest.fn(async () => occurrence),
    save: jest.fn(async (o: SpeakerOccurrenceEntity) => o),
  } as unknown as Repository<SpeakerOccurrenceEntity>;

  jest.spyOn(PyannoteAiClient, 'fromResolvedConfig').mockReturnValue({} as PyannoteAiClient);

  const service = new SpeakerReassignmentService(
    inbox,
    aiConfig,
    matcher,
    transcripts,
    profiles,
    occurrences,
  );
  return { service, matcher, profiles, occurrences, occurrence, savedProfiles };
}

describe('SpeakerReassignmentService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('re-points the occurrence to a fresh profile and enrolls a voiceprint', async () => {
    const { service, occurrences, occurrence, matcher, savedProfiles } = build({
      occurrence: { extractionId: 'ext-1', label: 'SPEAKER_00', voiceProfileId: 'old', similarity: 1 },
      enroll: 'vp-new',
    });

    const result = await service.reassign('u1', 'item-1', 'SPEAKER_00');

    // The occurrence now points at the new profile and the match score is cleared.
    expect(occurrence!.voiceProfileId).toBe('new-profile');
    expect(occurrence!.similarity).toBeNull();
    expect(occurrences.save).toHaveBeenCalledWith(occurrence);
    // Enrolled from this label's segments; the token lands on the new profile.
    expect(matcher.enrollVoiceprintForLabel).toHaveBeenCalledWith(
      'audio/1',
      'SPEAKER_00',
      [{ start: 0, end: 10 }],
      expect.anything(),
      cfg,
    );
    expect(savedProfiles.some((p) => p.voiceprint === 'vp-new')).toBe(true);
    expect(result).toBe(transcript);
  });

  it('still succeeds when enrollment yields no voiceprint', async () => {
    const { service, occurrence, savedProfiles } = build({
      occurrence: { extractionId: 'ext-1', label: 'SPEAKER_00', voiceProfileId: 'old', similarity: 1 },
      enroll: null,
    });

    await service.reassign('u1', 'item-1', 'SPEAKER_00');

    expect(occurrence!.voiceProfileId).toBe('new-profile');
    expect(savedProfiles.every((p) => p.voiceprint == null)).toBe(true);
  });

  it('404s when the recording has no such speaker label', async () => {
    const { service } = build({ occurrence: null });
    await expect(service.reassign('u1', 'item-1', 'SPEAKER_09')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

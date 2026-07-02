import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { SpeakerOccurrenceEntity, VoiceProfileEntity } from '@plaudern/persistence';
import {
  cosineSimilarity,
  l2Normalize,
  mergeCentroids,
  ProfileMatcherService,
} from './profile-matcher.service';

const USER = 'user-1';

/** Minimal in-memory stand-ins for the two repositories the matcher touches. */
function fakeRepos() {
  const profiles: VoiceProfileEntity[] = [];
  const occurrences: SpeakerOccurrenceEntity[] = [];
  let nextId = 1;

  const profileRepo = {
    find: jest.fn(async ({ where }: { where: { userId: string } }) =>
      profiles.filter((p) => p.userId === where.userId),
    ),
    create: jest.fn((data: Partial<VoiceProfileEntity>) => ({ ...data }) as VoiceProfileEntity),
    save: jest.fn(async (entity: VoiceProfileEntity) => {
      if (!entity.id) {
        entity.id = `profile-${nextId++}`;
        entity.createdAt = new Date();
        profiles.push(entity);
      }
      return entity;
    }),
  } as unknown as Repository<VoiceProfileEntity>;

  const occurrenceRepo = {
    delete: jest.fn(async ({ extractionId }: { extractionId: string }) => {
      for (let i = occurrences.length - 1; i >= 0; i--) {
        if (occurrences[i].extractionId === extractionId) occurrences.splice(i, 1);
      }
    }),
    create: jest.fn(
      (data: Partial<SpeakerOccurrenceEntity>) => ({ ...data }) as SpeakerOccurrenceEntity,
    ),
    save: jest.fn(async (entity: SpeakerOccurrenceEntity) => {
      entity.id = entity.id ?? `occ-${nextId++}`;
      occurrences.push(entity);
      return entity;
    }),
  } as unknown as Repository<SpeakerOccurrenceEntity>;

  return { profileRepo, occurrenceRepo, profiles, occurrences };
}

function build(threshold = '0.65') {
  const { profileRepo, occurrenceRepo, profiles, occurrences } = fakeRepos();
  const config = new ConfigService({ SPEAKER_MATCH_THRESHOLD: threshold });
  const matcher = new ProfileMatcherService(config, profileRepo, occurrenceRepo);
  return { matcher, profiles, occurrences };
}

const e = (values: number[]): number[] => l2Normalize(values);

describe('vector math', () => {
  it('computes cosine similarity of normalized vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('normalizes vectors and tolerates the zero vector', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8]);
    expect(l2Normalize([0, 0])).toEqual([0, 0]);
  });

  it('merges centroids weighted by count', () => {
    const merged = mergeCentroids([1, 0], 3, [0, 1], 1);
    expect(merged[0]).toBeGreaterThan(merged[1]);
    expect(Math.hypot(...merged)).toBeCloseTo(1);
  });
});

describe('ProfileMatcherService.assignSpeakers', () => {
  it('creates unconfirmed profiles for unknown voices', async () => {
    const { matcher, profiles } = build();
    const results = await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 },
      { label: 'SPEAKER_01', embedding: e([0, 1, 0]), speakingSeconds: 5 },
    ]);
    expect(profiles).toHaveLength(2);
    expect(profiles.every((p) => p.status === 'unconfirmed' && p.name === null)).toBe(true);
    expect(results.map((r) => r.similarity)).toEqual([null, null]);
  });

  it('matches a returning voice to its profile and updates the centroid', async () => {
    const { matcher, profiles } = build();
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 },
    ]);
    const [profile] = profiles;

    const results = await matcher.assignSpeakers(USER, 'item-2', 'ext-2', [
      { label: 'SPEAKER_00', embedding: e([0.9, 0.1, 0]), speakingSeconds: 8 },
    ]);

    expect(profiles).toHaveLength(1);
    expect(results[0].voiceProfileId).toBe(profile.id);
    expect(results[0].similarity).toBeGreaterThan(0.9);
    expect(profile.embeddingCount).toBe(2);
    expect(Math.hypot(...profile.centroid)).toBeCloseTo(1);
    // Centroid drifted toward the new embedding.
    expect(profile.centroid[1]).toBeGreaterThan(0);
  });

  it('rejects matches below the threshold', async () => {
    const { matcher, profiles } = build();
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 },
    ]);
    await matcher.assignSpeakers(USER, 'item-2', 'ext-2', [
      { label: 'SPEAKER_00', embedding: e([0.3, 1, 0]), speakingSeconds: 10 },
    ]);
    expect(profiles).toHaveLength(2);
  });

  it('never assigns two speakers of one recording to the same profile', async () => {
    const { matcher, profiles, occurrences } = build();
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 },
    ]);
    const [profile] = profiles;

    // Both new speakers are similar to the stored profile; only the closer
    // one may claim it.
    await matcher.assignSpeakers(USER, 'item-2', 'ext-2', [
      { label: 'SPEAKER_00', embedding: e([0.95, 0.05, 0]), speakingSeconds: 4 },
      { label: 'SPEAKER_01', embedding: e([0.9, 0.1, 0]), speakingSeconds: 4 },
    ]);

    const matched = occurrences.filter(
      (o) => o.extractionId === 'ext-2' && o.voiceProfileId === profile.id,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0].label).toBe('SPEAKER_00');
    expect(profiles).toHaveLength(2);
  });

  it('ignores profiles whose embedding dimension differs', async () => {
    const { matcher, profiles } = build();
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 },
    ]);
    await matcher.assignSpeakers(USER, 'item-2', 'ext-2', [
      { label: 'SPEAKER_00', embedding: e([1, 0, 0, 0]), speakingSeconds: 10 },
    ]);
    expect(profiles).toHaveLength(2);
  });

  it('is idempotent per extraction (queue retry safety)', async () => {
    const { matcher, occurrences } = build();
    const speakers = [{ label: 'SPEAKER_00', embedding: e([1, 0, 0]), speakingSeconds: 10 }];
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', speakers);
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', speakers);
    expect(occurrences.filter((o) => o.extractionId === 'ext-1')).toHaveLength(1);
  });

  it('normalizes non-normalized provider embeddings before matching', async () => {
    const { matcher, profiles } = build();
    await matcher.assignSpeakers(USER, 'item-1', 'ext-1', [
      { label: 'SPEAKER_00', embedding: [10, 0, 0], speakingSeconds: 10 },
    ]);
    await matcher.assignSpeakers(USER, 'item-2', 'ext-2', [
      { label: 'SPEAKER_00', embedding: [5, 0, 0], speakingSeconds: 10 },
    ]);
    expect(profiles).toHaveLength(1);
  });
});

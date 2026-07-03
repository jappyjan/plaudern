import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SpeakerOccurrenceEntity, VoiceProfileEntity } from '@plaudern/persistence';
import type { DiarizedSpeaker } from './diarization.provider';

/** Dot product of two L2-normalized vectors == cosine similarity. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

export function l2Normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) return v.slice();
  return v.map((x) => x / norm);
}

/** Weighted mean of two normalized vectors, re-normalized. */
export function mergeCentroids(a: number[], countA: number, b: number[], countB: number): number[] {
  const merged = a.map((x, i) => x * countA + b[i] * countB);
  return l2Normalize(merged);
}

/**
 * Links diarized speakers to persistent voice profiles. High-similarity voices
 * auto-match an existing profile (updating its centroid); everything else
 * creates a new `unconfirmed` profile the user reviews in the contact book.
 */
@Injectable()
export class ProfileMatcherService {
  private readonly threshold: number;

  constructor(
    config: ConfigService,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
  ) {
    this.threshold = Number(config.get<string>('SPEAKER_MATCH_THRESHOLD', '0.65'));
  }

  async assignSpeakers(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    speakers: DiarizedSpeaker[],
  ): Promise<SpeakerOccurrenceEntity[]> {
    // Queue retries after a partial failure re-run the whole assignment.
    await this.occurrences.delete({ extractionId });
    if (speakers.length === 0) return [];

    const normalized = speakers.map((s) => ({ ...s, embedding: l2Normalize(s.embedding) }));
    const dim = normalized[0].embedding.length;
    // Profiles with a different embedding dimension (e.g. from another
    // provider) can never match; treat them as absent candidates.
    const candidates = (await this.profiles.find({ where: { userId } })).filter(
      (p): p is VoiceProfileEntity & { centroid: number[] } =>
        p.centroid != null && p.centroid.length === dim,
    );

    // Greedy assignment over the full similarity matrix, best pairs first.
    // Each profile is usable at most once per recording — two diarized
    // speakers in one recording cannot be the same person.
    const pairs: { speakerIdx: number; profile: VoiceProfileEntity; similarity: number }[] = [];
    normalized.forEach((speaker, speakerIdx) => {
      for (const profile of candidates) {
        const similarity = cosineSimilarity(speaker.embedding, profile.centroid);
        if (similarity >= this.threshold) pairs.push({ speakerIdx, profile, similarity });
      }
    });
    pairs.sort((a, b) => b.similarity - a.similarity);

    const assignedSpeakers = new Map<number, { profile: VoiceProfileEntity; similarity: number }>();
    const usedProfiles = new Set<string>();
    for (const pair of pairs) {
      if (assignedSpeakers.has(pair.speakerIdx) || usedProfiles.has(pair.profile.id)) continue;
      assignedSpeakers.set(pair.speakerIdx, { profile: pair.profile, similarity: pair.similarity });
      usedProfiles.add(pair.profile.id);
    }

    const results: SpeakerOccurrenceEntity[] = [];
    for (let i = 0; i < normalized.length; i++) {
      const speaker = normalized[i];
      const match = assignedSpeakers.get(i);

      let profile: VoiceProfileEntity;
      let similarity: number | null;
      if (match) {
        profile = match.profile;
        similarity = match.similarity;
        // Candidates were filtered to non-null centroids, so this branch always
        // has one; the guard keeps the compiler honest without an assertion.
        profile.centroid = mergeCentroids(
          profile.centroid ?? speaker.embedding,
          profile.embeddingCount,
          speaker.embedding,
          1,
        );
        profile.embeddingCount += 1;
        await this.profiles.save(profile);
      } else {
        profile = await this.profiles.save(
          this.profiles.create({
            userId,
            name: null,
            status: 'unconfirmed',
            centroid: speaker.embedding,
            embeddingCount: 1,
          }),
        );
        similarity = null;
      }

      results.push(
        await this.occurrences.save(
          this.occurrences.create({
            inboxItemId,
            extractionId,
            voiceProfileId: profile.id,
            label: speaker.label,
            embedding: speaker.embedding,
            speakingSeconds: speaker.speakingSeconds,
            similarity,
          }),
        ),
      );
    }
    return results;
  }
}

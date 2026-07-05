import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VoiceProfileEntity } from '@plaudern/persistence';

/** Minimal shape the owner resolver needs from a diarization occurrence row. */
export interface OwnerOccurrence {
  label: string;
  voiceProfileId: string;
}

/** Owner attribution for one recording, derived from the user's self profile. */
export interface OwnerResolution {
  /** True when the user has designated an account owner ("This is me"). */
  hasOwner: boolean;
  /** The owner's diarization label in this recording, or null if they did not speak / no diarization. */
  ownerLabel: string | null;
  /** The owner's name, whenever a self profile exists (independent of this recording). */
  ownerName: string | null;
}

/**
 * Resolves the account owner ("me") for a user and, given a recording's speaker
 * occurrences, which diarization label is the owner's. Shared by the owner-
 * relative extractors (commitments, tasks) and their read/gating paths so the
 * "who is me" query lives in one place. Lives in the inbox lib because every
 * consumer (and speaker-id) already depends on it, avoiding a module cycle.
 */
@Injectable()
export class SelfProfileService {
  constructor(
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
  ) {}

  /** The user's self voice profile, or null when none is marked. */
  getSelf(userId: string): Promise<VoiceProfileEntity | null> {
    return this.profiles.findOne({ where: { userId, isSelf: true } });
  }

  /** Whether the user has designated an account owner at all. */
  async hasOwner(userId: string): Promise<boolean> {
    return (await this.profiles.count({ where: { userId, isSelf: true } })) > 0;
  }

  /**
   * Resolve owner attribution for a recording from its occurrence rows. Pass the
   * already-loaded self profile (or null) to avoid a second query.
   */
  resolveOwner(self: VoiceProfileEntity | null, occurrences: OwnerOccurrence[]): OwnerResolution {
    if (!self) return { hasOwner: false, ownerLabel: null, ownerName: null };
    const ownerLabel = ownerLabelFromOccurrences(occurrences, self.id);
    return { hasOwner: true, ownerLabel, ownerName: self.name };
  }
}

/** The owner's diarization label in a recording, or null when they do not appear. */
export function ownerLabelFromOccurrences(
  occurrences: OwnerOccurrence[],
  selfProfileId: string,
): string | null {
  return occurrences.find((o) => o.voiceProfileId === selfProfileId)?.label ?? null;
}

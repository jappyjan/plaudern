import type { ConsentStatus, RegistryEntityDto, VoiceProfileDto } from '@plaudern/contracts';

/**
 * A single real-world person for the unified People hub. Contacts (voices the
 * system *heard*) and `person` registry entities (people *mentioned* in
 * transcripts) are two representations of the same person, already linked by
 * `entity.voiceProfileId`; this collapses them into one card so a person is
 * never listed twice.
 *
 * `provenance` records which halves we have:
 * - `both`     — a voice profile with a linked person entity
 * - `heard`    — a voice profile with no linked entity
 * - `mentioned`— a person entity with no linked voice profile
 */
export type PersonProvenance = 'both' | 'heard' | 'mentioned';

export interface UnifiedPerson {
  /** Stable key/avatar seed: the voice-profile id when heard, else the entity id. */
  key: string;
  name: string | null;
  provenance: PersonProvenance;
  /** Where tapping the card navigates (contact detail when heard, else entity). */
  detailTo: string;
  /** Present whenever a voice profile backs this person (`both` | `heard`). */
  voiceProfile: VoiceProfileDto | null;
  /** Present whenever a person entity backs this person (`both` | `mentioned`). */
  entity: RegistryEntityDto | null;
  /** Recordings the voice appears in (0 when mentioned-only). */
  recordingCount: number;
  /** Distinct recordings the person is mentioned in (0 when heard-only). */
  mentionCount: number;
  consentStatus: ConsentStatus | null;
  redacted: boolean;
  /** True for a heard person still awaiting review/confirmation. */
  unconfirmed: boolean;
  /** Most recent activity across heard + mentioned, for sorting. ISO or null. */
  lastActivityAt: string | null;
}

/** Latest of two nullable ISO timestamps (either may be null). */
function laterOf(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function fromProfile(profile: VoiceProfileDto, entity: RegistryEntityDto | null): UnifiedPerson {
  return {
    key: profile.id,
    // A named entity can supply a name for an as-yet-unnamed voice profile.
    name: profile.name ?? entity?.canonicalName ?? null,
    provenance: entity ? 'both' : 'heard',
    detailTo: `/contacts/${profile.id}`,
    voiceProfile: profile,
    entity,
    recordingCount: profile.recordingCount,
    mentionCount: entity?.mentionCount ?? 0,
    consentStatus: profile.consentStatus,
    redacted: profile.redacted,
    unconfirmed: profile.status === 'unconfirmed',
    lastActivityAt: laterOf(profile.lastHeardAt, entity?.lastSeenAt ?? null),
  };
}

function fromEntity(entity: RegistryEntityDto): UnifiedPerson {
  return {
    key: entity.id,
    name: entity.canonicalName,
    provenance: 'mentioned',
    detailTo: `/entities/${entity.id}`,
    voiceProfile: null,
    entity,
    recordingCount: 0,
    mentionCount: entity.mentionCount,
    consentStatus: null,
    redacted: false,
    unconfirmed: false,
    lastActivityAt: entity.lastSeenAt,
  };
}

/**
 * Merge voice-profile contacts and `person` entities into one deduped list,
 * newest activity first. A person entity with a `voiceProfileId` matching a
 * known contact is folded into that contact's card (`both`); otherwise it
 * stands alone as `mentioned`. Contacts with no linked entity are `heard`.
 *
 * The caller passes only `person`-typed entities. Sorting is by the more
 * recent of last-heard / last-seen so active people surface first.
 */
export function mergePeople(
  profiles: VoiceProfileDto[],
  personEntities: RegistryEntityDto[],
): UnifiedPerson[] {
  const profileById = new Map(profiles.map((p) => [p.id, p]));
  // Which entity (if any) is linked to each profile — first link wins; a
  // profile realistically carries at most one linked person entity.
  const entityByProfile = new Map<string, RegistryEntityDto>();
  const mentionedOnly: RegistryEntityDto[] = [];

  for (const entity of personEntities) {
    if (entity.voiceProfileId && profileById.has(entity.voiceProfileId)) {
      if (!entityByProfile.has(entity.voiceProfileId)) {
        entityByProfile.set(entity.voiceProfileId, entity);
      }
    } else {
      // No link (or a link to a profile we don't have) → its own card.
      mentionedOnly.push(entity);
    }
  }

  const people: UnifiedPerson[] = [
    ...profiles.map((profile) => fromProfile(profile, entityByProfile.get(profile.id) ?? null)),
    ...mentionedOnly.map(fromEntity),
  ];

  return people.sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''));
}

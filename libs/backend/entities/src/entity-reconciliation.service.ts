import { Injectable, NotFoundException } from '@nestjs/common';
import type { DuplicateCandidateDto, RegistryEntityDto } from '@plaudern/contracts';
import { EntitiesRegistryService } from './entities-registry.service';
import { bestNameAffinity, FUZZY_DUPLICATE_FLOOR, nameKeys } from './contact-matching';

/** Cap the candidate list so the UI (and any downstream judge) stays bounded. */
const MAX_CANDIDATES = 10;

/**
 * Duplicate reconciliation (JJ-63). The extractor tags the same real-world
 * thing with different types across recordings (an organization in one, a
 * product in another), so the deterministic (type, normalizedName) dedupe
 * leaves two rows behind. This service surfaces those likely duplicates for an
 * entity so the user can merge them (merges themselves always go through the
 * confirm flow — this service never mutates entities):
 *
 *  - `exact-cross-type`: another entity whose (folded) name matches but whose
 *    type differs — the split-typed case, high precision, surfaced directly.
 *  - `fuzzy`: a similar name (possibly the same type), lexically close enough
 *    to be worth confirming — gated by FUZZY_DUPLICATE_FLOOR.
 *
 * Matching is pure JS over the user's entity list (there are no entity
 * embeddings and no pg_trgm), so it behaves identically on Postgres and the
 * sqlite test driver.
 */
@Injectable()
export class EntityReconciliationService {
  constructor(private readonly registry: EntitiesRegistryService) {}

  /**
   * Ranked duplicate candidates for one entity: exact cross-type first (score
   * 1), then fuzzy name matches (score = affinity) when `fuzzy` is requested.
   * Cheap — no LLM, no network.
   */
  async findCandidates(
    userId: string,
    entityId: string,
    opts: { fuzzy?: boolean } = {},
  ): Promise<DuplicateCandidateDto[]> {
    // Include unreferenced rows so a stray ghost duplicate is still surfaced.
    const all = await this.registry.list(userId, undefined, true);
    const subject = all.find((e) => e.id === entityId);
    if (!subject) throw new NotFoundException('entity not found');

    const subjectNames = namesOf(subject);
    const subjectKeys = new Set(subjectNames.flatMap(nameKeys));

    const candidates: DuplicateCandidateDto[] = [];
    for (const other of all) {
      if (other.id === subject.id) continue;
      const otherNames = namesOf(other);
      const exact =
        other.type !== subject.type && otherNames.flatMap(nameKeys).some((k) => subjectKeys.has(k));
      if (exact) {
        candidates.push({ candidate: other, reason: 'exact-cross-type', score: 1 });
        continue;
      }
      if (!opts.fuzzy) continue;
      const score = bestNameAffinity(subjectNames, otherNames);
      if (score >= FUZZY_DUPLICATE_FLOOR) {
        candidates.push({ candidate: other, reason: 'fuzzy', score });
      }
    }

    return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  }
}

/** An entity's full set of name forms: canonical plus every known alias. */
function namesOf(entity: RegistryEntityDto): string[] {
  return [entity.canonicalName, ...entity.aliases];
}

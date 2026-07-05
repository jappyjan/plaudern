import { EntityManager, In } from 'typeorm';
import { ExtractedPayloadEntity } from './entities/extracted-payload.entity';
import { PersonalFactCitationEntity } from './entities/personal-fact-citation.entity';
import { PersonalFactEntity } from './entities/personal-fact.entity';

/** One (subject, attribute) supersession group of a user's personal facts. */
export interface PersonalFactGroupKey {
  userId: string;
  subjectKey: string;
  normalizedAttribute: string;
}

/**
 * Recompute the supersession invariant for a set of personal-fact groups
 * (JJ-31). Lives in @plaudern/persistence — not @plaudern/facts — because every
 * writer that can break the invariant must be able to restore it, and the inbox
 * delete path and the entity-merge path (JJ-63) cannot depend on the facts lib
 * without a dependency cycle (facts → inbox).
 *
 * The invariant, per (userId, subjectKey, normalizedAttribute) group:
 *  - A fact is ELIGIBLE for the active slot only when it is citation-live: it
 *    has at least one citation on its item's newest relevant `facts` extraction
 *    (succeeded rows, plus the in-flight `activeExtractionId` during ingest —
 *    that row is not yet `succeeded` but its citations are the item's current
 *    truth). A fact a re-extraction stopped producing keeps only stale
 *    citations and drops out, letting an older sibling re-activate.
 *  - ACCUMULATIVE facts (exclusive=false) are never superseded: pointers are
 *    cleared. They coexist (allergies, gift ideas); read models hide the
 *    citation-stale ones via their citation counts.
 *  - Among EXCLUSIVE facts, the eligible one backed by the newest recording
 *    (`lastOccurredAt`, tiebroken by newest createdAt then id) is ACTIVE;
 *    every other exclusive fact in the group points at it via
 *    `supersededByFactId` (+ `supersededAt`, stamped once). With no eligible
 *    exclusive fact, all pointers are cleared (nothing visible is replaced by
 *    anything). Rows are never deleted here — supersession stays append-only.
 *
 * Deterministic and idempotent: recomputing converges on the same state
 * regardless of ingest/delete/merge ordering. Callers pass the transaction's
 * EntityManager so the recompute commits atomically with the mutation that
 * disturbed the group.
 */
export async function recomputePersonalFactSupersession(
  manager: EntityManager,
  groups: PersonalFactGroupKey[],
  activeExtractionId?: string,
): Promise<void> {
  const seen = new Set<string>();
  for (const group of groups) {
    const key = `${group.userId}::${group.subjectKey}::${group.normalizedAttribute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await recomputeGroup(manager, group, activeExtractionId);
  }
}

async function recomputeGroup(
  manager: EntityManager,
  { userId, subjectKey, normalizedAttribute }: PersonalFactGroupKey,
  activeExtractionId?: string,
): Promise<void> {
  const facts = await manager.find(PersonalFactEntity, {
    where: { userId, subjectKey, normalizedAttribute },
  });
  if (facts.length === 0) return;

  const eligible = await citationLiveFactIds(
    manager,
    facts.map((f) => f.id),
    activeExtractionId,
  );
  const winner =
    facts
      .filter((f) => f.exclusive && eligible.has(f.id))
      .sort(byRecencyDesc)[0] ?? null;

  const now = new Date().toISOString();
  for (const fact of facts) {
    const supersededBy =
      fact.exclusive && winner && fact.id !== winner.id ? winner.id : null;
    if (supersededBy === null) {
      if (fact.supersededByFactId !== null || fact.supersededAt !== null) {
        fact.supersededByFactId = null;
        fact.supersededAt = null;
        await manager.save(fact);
      }
    } else if (fact.supersededByFactId !== supersededBy) {
      fact.supersededByFactId = supersededBy;
      // Stamped once — the first time the fact fell out of the active slot.
      fact.supersededAt = fact.supersededAt ?? now;
      await manager.save(fact);
    }
  }
}

/**
 * The subset of `factIds` with at least one citation on its item's newest
 * relevant `facts` extraction (succeeded, or the in-flight one during ingest).
 */
async function citationLiveFactIds(
  manager: EntityManager,
  factIds: string[],
  activeExtractionId?: string,
): Promise<Set<string>> {
  const live = new Set<string>();
  if (factIds.length === 0) return live;
  const citations = await manager.find(PersonalFactCitationEntity, {
    where: { factId: In(factIds) },
  });
  if (citations.length === 0) return live;

  const itemIds = [...new Set(citations.map((c) => c.inboxItemId))];
  const extractions = await manager.find(ExtractedPayloadEntity, {
    where: { inboxItemId: In(itemIds), kind: 'facts' },
  });
  const latestByItem = new Map<string, ExtractedPayloadEntity>();
  for (const row of extractions) {
    if (row.status !== 'succeeded' && row.id !== activeExtractionId) continue;
    const current = latestByItem.get(row.inboxItemId);
    if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
  }
  const liveExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));

  for (const citation of citations) {
    if (liveExtractionIds.has(citation.extractionId)) live.add(citation.factId);
  }
  return live;
}

/** Newest supporting recording first (nulls last), tiebroken by newest row then id. */
function byRecencyDesc(a: PersonalFactEntity, b: PersonalFactEntity): number {
  const ao = a.lastOccurredAt ?? '';
  const bo = b.lastOccurredAt ?? '';
  if (ao !== bo) return ao < bo ? 1 : -1;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) {
    return b.createdAt.getTime() - a.createdAt.getTime();
  }
  return a.id < b.id ? 1 : -1;
}

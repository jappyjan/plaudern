import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  DuplicateCandidateDto,
  MergeSuggestionDto,
  MergeSuggestionStatus,
  ReconcileRecommendation,
  RegistryEntityDto,
} from '@plaudern/contracts';
import {
  EntityMentionEntity,
  EntityMergeSuggestionEntity,
  EntityRegistryEntity,
} from '@plaudern/persistence';
import { EntitiesRegistryService } from './entities-registry.service';
import { ENTITY_JUDGE_PROVIDER, type EntityJudgeProvider } from './entity-judge.provider';
import { bestNameAffinity, FUZZY_DUPLICATE_FLOOR, nameKeys } from './contact-matching';

/** Cap the candidate list so the UI (and any downstream judge) stays bounded. */
const MAX_CANDIDATES = 10;

/**
 * Duplicate reconciliation (JJ-63). The extractor tags the same real-world
 * thing with different types across recordings (an organization in one, a
 * product in another), so the deterministic (type, normalizedName) dedupe
 * leaves two rows behind. This service surfaces those likely duplicates so the
 * user can merge them — it NEVER mutates entities itself; merges always go
 * through the confirm flow and the transactional correction path:
 *
 *  - `exact-cross-type`: another entity whose (folded) name matches but whose
 *    type differs — the split-typed case, high precision, surfaced directly.
 *  - `fuzzy`: a similar name (possibly the same type), lexically close enough
 *    to be worth confirming — gated by FUZZY_DUPLICATE_FLOOR.
 *
 * Matching is pure JS over the user's entity list (there are no entity
 * embeddings and no pg_trgm), so it behaves identically on Postgres and the
 * sqlite test driver. Automatic detection after extraction records cheap
 * exact-cross-type pairs as `pending` suggestions; the fuzzy sweep and any
 * LLM/web judging happen only on demand.
 */
@Injectable()
export class EntityReconciliationService {
  constructor(
    private readonly registry: EntitiesRegistryService,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(EntityMentionEntity)
    private readonly mentions: Repository<EntityMentionEntity>,
    @InjectRepository(EntityMergeSuggestionEntity)
    private readonly suggestions: Repository<EntityMergeSuggestionEntity>,
    @Inject(ENTITY_JUDGE_PROVIDER)
    private readonly judge: EntityJudgeProvider,
  ) {}

  /**
   * Ask the LLM judge whether two entities are the same real-world thing, and if
   * so which type/survivor to keep. Read-only — it never merges. Returns null
   * when no judge is configured, so callers degrade gracefully. When a recorded
   * suggestion exists for the pair, its judgment fields are updated in place.
   */
  async recommend(
    userId: string,
    entityId: string,
    candidateId: string,
    _opts: { web?: boolean } = {},
  ): Promise<ReconcileRecommendation | null> {
    const all = await this.registry.list(userId, undefined, true);
    const subject = all.find((e) => e.id === entityId);
    const candidate = all.find((e) => e.id === candidateId);
    if (!subject || !candidate) throw new NotFoundException('entity not found');
    if (!this.judge.enabled) return null;

    // Web research is wired in a later phase; nothing leaves the network here.
    const usedWeb = false;
    const { decision } = await this.judge.judge({
      subject: { name: subject.canonicalName, type: subject.type, aliases: subject.aliases },
      candidate: { name: candidate.canonicalName, type: candidate.type, aliases: candidate.aliases },
    });
    const survivorId = decision.survivor === 'candidate' ? candidate.id : subject.id;
    const recommendation: ReconcileRecommendation = {
      sameThing: decision.sameThing,
      recommendedType: decision.recommendedType,
      survivorId,
      confidence: decision.confidence,
      rationale: decision.rationale,
      usedWeb,
    };

    await this.recordJudgment(userId, subject.id, candidate.id, recommendation).catch(() => {
      // Best-effort: a failed persist doesn't invalidate the returned advice.
    });
    return recommendation;
  }

  /** Persist a judgment onto an existing suggestion row for the pair, if any. */
  private async recordJudgment(
    userId: string,
    aId: string,
    bId: string,
    rec: ReconcileRecommendation,
  ): Promise<void> {
    const [entityId, candidateEntityId] = [aId, bId].sort();
    const row = await this.suggestions.findOne({
      where: { userId, entityId, candidateEntityId },
    });
    if (!row) return;
    row.sameThing = rec.sameThing;
    row.recommendedType = rec.recommendedType;
    row.recommendedSurvivorId = rec.survivorId;
    row.confidence = rec.confidence;
    row.rationale = rec.rationale;
    row.usedWeb = rec.usedWeb;
    await this.suggestions.save(row);
  }

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

  /**
   * Hot-path detection run best-effort after each extraction: for every entity
   * this recording mentioned, record `pending` suggestions for any existing
   * entity with the same (folded) name under a DIFFERENT type. Exact-only — no
   * fuzzy sweep, no LLM, no network. Idempotent on the canonicalized pair, and a
   * previously dismissed pair is left dismissed. Returns how many new
   * suggestions were written.
   */
  async detectExactForItem(userId: string, inboxItemId: string): Promise<number> {
    const itemMentions = await this.mentions.find({ where: { userId, inboxItemId } });
    const mentionedIds = new Set(itemMentions.map((m) => m.entityId));
    if (mentionedIds.size === 0) return 0;

    const all = await this.entities.find({ where: { userId } });
    const keysById = new Map(all.map((e) => [e.id, new Set(rowKeys(e))] as const));

    let created = 0;
    const seenPairs = new Set<string>();
    for (const subject of all) {
      if (!mentionedIds.has(subject.id)) continue;
      const subjectKeys = keysById.get(subject.id)!;
      for (const other of all) {
        if (other.id === subject.id || other.type === subject.type) continue;
        const otherKeys = keysById.get(other.id)!;
        if (![...otherKeys].some((k) => subjectKeys.has(k))) continue;

        const [a, b] = [subject.id, other.id].sort();
        const pairKey = `${a}:${b}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const existing = await this.suggestions.findOne({
          where: { userId, entityId: a, candidateEntityId: b },
        });
        if (existing) continue;
        await this.suggestions.save(
          this.suggestions.create({
            userId,
            entityId: a,
            candidateEntityId: b,
            source: 'auto',
            status: 'pending',
            usedWeb: false,
          }),
        );
        created += 1;
      }
    }
    return created;
  }

  /**
   * Recorded merge suggestions for the "possible duplicates" surface, newest
   * first. Both sides are resolved to full registry DTOs; a suggestion whose
   * entity no longer exists (e.g. merged/deleted before cascade caught up) is
   * skipped.
   */
  async listSuggestions(
    userId: string,
    status: MergeSuggestionStatus = 'pending',
  ): Promise<MergeSuggestionDto[]> {
    const rows = await this.suggestions.find({ where: { userId, status } });
    if (rows.length === 0) return [];
    const byId = new Map(
      (await this.registry.list(userId, undefined, true)).map((e) => [e.id, e] as const),
    );
    return rows
      .map((row) => {
        const entity = byId.get(row.entityId);
        const candidate = byId.get(row.candidateEntityId);
        if (!entity || !candidate) return null;
        return {
          id: row.id,
          entity,
          candidate,
          recommendedSurvivorId: row.recommendedSurvivorId,
          recommendedType: row.recommendedType,
          sameThing: row.sameThing,
          confidence: row.confidence,
          rationale: row.rationale,
          usedWeb: row.usedWeb,
          source: row.source,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
        } satisfies MergeSuggestionDto;
      })
      .filter((dto): dto is MergeSuggestionDto => dto !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Mark a suggestion dismissed so it is not surfaced again. */
  async dismiss(userId: string, suggestionId: string): Promise<void> {
    const row = await this.suggestions.findOne({ where: { id: suggestionId, userId } });
    if (!row) throw new NotFoundException('suggestion not found');
    row.status = 'dismissed';
    await this.suggestions.save(row);
  }
}

/** An entity's full set of name forms: canonical plus every known alias. */
function namesOf(entity: RegistryEntityDto): string[] {
  return [entity.canonicalName, ...entity.aliases];
}

/** Folded match keys for a raw registry row (canonical + aliases). */
function rowKeys(row: EntityRegistryEntity): string[] {
  return [row.canonicalName, ...(row.aliases ?? [])].flatMap(nameKeys);
}

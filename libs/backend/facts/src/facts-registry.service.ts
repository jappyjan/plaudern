import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  FactCitationDto,
  FactListQuery,
  ItemFactsResponse,
  PersonalFactDto,
} from '@plaudern/contracts';
import { factExtractionPayloadSchema } from '@plaudern/contracts';
import {
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  recomputePersonalFactSupersession,
  type PersonalFactGroupKey,
} from '@plaudern/persistence';

/**
 * Upper bound on candidate facts ingested per extraction — a defensive cap on
 * unbounded LLM output (a hallucinating model must not flood the table).
 */
export const MAX_FACTS_PER_EXTRACTION = 50;
const MAX_VALUE_CHARS = 500;
const MAX_ATTRIBUTE_CHARS = 80;
const MAX_PERSON_CHARS = 200;
const MAX_QUOTE_CHARS = 1_000;

/** A resolved candidate personal fact ready to be deduped into the store. */
export interface FactCandidate {
  /** The subject's name as spoken; empty when unknown (then the fact is dropped). */
  person: string;
  attribute: string;
  value: string;
  /** Whether the attribute holds one current value (participates in supersession). */
  exclusive: boolean;
  quote: string | null;
  startSeconds: number | null;
}

/**
 * Owns the per-user personal-facts store (JJ-31): resolving extracted candidate
 * facts to a subject (a registry `person` entity when the name matches, else a
 * raw name), deduplicating them into `personal_facts` rows with
 * `personal_fact_citations` edges, and maintaining APPEND-ONLY SUPERSESSION
 * among EXCLUSIVE facts — within a (subject, attribute) group the citation-live
 * exclusive fact backed by the most recent recording is active; other exclusive
 * facts point at it via `supersededByFactId` and are kept as history, while
 * accumulative facts (allergies, gift ideas) coexist untouched. The invariant
 * itself lives in `recomputePersonalFactSupersession` (@plaudern/persistence)
 * so the inbox delete path and the entity merge can restore it too. Also serves
 * the read models (per-person list, an item's facts tab).
 *
 * Citations are keyed to the `facts` extraction that produced them; the read
 * models restrict citation aggregates to each item's LATEST succeeded `facts`
 * extraction, so append-only reprocessing supersedes old citations without ever
 * duplicating a fact (mirrors the tasks registry + entity-mention aggregation).
 */
@Injectable()
export class FactsRegistryService {
  private readonly logger = new Logger(FactsRegistryService.name);

  constructor(
    @InjectRepository(PersonalFactEntity)
    private readonly facts: Repository<PersonalFactEntity>,
    @InjectRepository(PersonalFactCitationEntity)
    private readonly citations: Repository<PersonalFactCitationEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
  ) {}

  /**
   * Dedupe a batch of candidate facts into the user's store and append one
   * citation per distinct fact for this extraction, then recompute supersession
   * for every (subject, attribute) group the batch touched — INCLUDING the
   * groups of facts this item's EARLIER extractions cited. That second set is
   * what keeps a reprocess honest: a fact the new extraction stopped producing
   * goes citation-stale and must release the active slot to a superseded
   * sibling, and that sibling's group can only heal if it is recomputed. Runs
   * even when the batch is empty (a re-run that found nothing still stales the
   * item's previous facts). Returns the number of distinct facts the item was
   * linked to.
   */
  async ingest(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    occurredAt: string | null | undefined,
    candidates: FactCandidate[],
  ): Promise<number> {
    // Clamp adversarial/verbose output and drop facts with no subject or no
    // value — an unattributed fact is useless for a per-person store.
    const cleaned: FactCandidate[] = [];
    for (const raw of candidates) {
      const person = clamp(raw.person, MAX_PERSON_CHARS);
      const attribute = clamp(raw.attribute, MAX_ATTRIBUTE_CHARS);
      const value = clamp(raw.value, MAX_VALUE_CHARS);
      if (!person || !attribute || !value) continue;
      cleaned.push({
        person,
        attribute,
        value,
        exclusive: raw.exclusive === true,
        quote: raw.quote ? clamp(raw.quote, MAX_QUOTE_CHARS) : null,
        startSeconds: raw.startSeconds,
      });
      if (cleaned.length >= MAX_FACTS_PER_EXTRACTION) break;
    }

    const personByName = cleaned.length > 0 ? await this.personEntities(userId) : new Map<string, string>();

    // One transaction for the whole batch — the fact/citation writes AND the
    // supersession recompute commit atomically, so a concurrent list() never
    // sees a group mid-flip (old winner stamped superseded before the new one
    // is visible). Matches the delete/merge paths, which already pass their
    // transaction manager to recomputePersonalFactSupersession.
    return this.facts.manager.connection.transaction(async (em) => {
      const factRepo = em.getRepository(PersonalFactEntity);
      const citationRepo = em.getRepository(PersonalFactCitationEntity);

      const touchedGroups = new Map<string, PersonalFactGroupKey>();
      const touch = (subjectKey: string, normalizedAttribute: string) =>
        touchedGroups.set(`${subjectKey}::${normalizedAttribute}`, {
          userId,
          subjectKey,
          normalizedAttribute,
        });

      // Groups of facts this item's earlier extractions cited: a reprocess that
      // drops a fact must let its group re-elect an active fact.
      const priorCitations = await citationRepo.find({
        where: { inboxItemId },
        select: { factId: true },
      });
      const priorFactIds = [...new Set(priorCitations.map((c) => c.factId))];
      if (priorFactIds.length > 0) {
        const priorFacts = await factRepo.find({ where: { id: In(priorFactIds) } });
        for (const fact of priorFacts) touch(fact.subjectKey, fact.normalizedAttribute);
      }

      const cited = new Set<string>();
      for (const candidate of cleaned) {
        const normalizedPerson = normalize(candidate.person);
        const personEntityId = personByName.get(normalizedPerson) ?? null;
        const subjectKey = personEntityId ? `e:${personEntityId}` : `n:${normalizedPerson}`;
        const normalizedAttribute = normalize(candidate.attribute);
        const normalizedValue = normalize(candidate.value);

        const factId = await this.resolveFact(factRepo, userId, {
          personEntityId,
          personName: candidate.person,
          subjectKey,
          attribute: candidate.attribute,
          normalizedAttribute,
          value: candidate.value,
          normalizedValue,
          exclusive: candidate.exclusive,
          occurredAt: occurredAt ?? null,
        });
        await this.upsertCitation(citationRepo, userId, inboxItemId, extractionId, factId, candidate);
        cited.add(factId);
        touch(subjectKey, normalizedAttribute);
      }

      // The in-flight extraction id is passed through so its citations count as
      // the item's current truth even though its row isn't `succeeded` yet.
      await recomputePersonalFactSupersession(em, [...touchedGroups.values()], extractionId);
      return cited.size;
    });
  }

  /** Find the existing fact row for this (subject, attribute, value) or create it. */
  private async resolveFact(
    factRepo: Repository<PersonalFactEntity>,
    userId: string,
    fields: {
      personEntityId: string | null;
      personName: string;
      subjectKey: string;
      attribute: string;
      normalizedAttribute: string;
      value: string;
      normalizedValue: string;
      exclusive: boolean;
      occurredAt: string | null;
    },
  ): Promise<string> {
    const where = {
      userId,
      subjectKey: fields.subjectKey,
      normalizedAttribute: fields.normalizedAttribute,
      normalizedValue: fields.normalizedValue,
    };
    const existing = await factRepo.findOne({ where });
    if (existing) {
      // Refresh mutable, non-identity fields: adopt a newer linkage / spelling /
      // classification and advance recency so supersession sees the latest
      // supporting instant.
      let dirty = false;
      if (fields.personEntityId && existing.personEntityId !== fields.personEntityId) {
        existing.personEntityId = fields.personEntityId;
        dirty = true;
      }
      if (existing.exclusive !== fields.exclusive) {
        // Adopt the newest statement's classification; the group recompute that
        // follows re-establishes the invariant either way.
        existing.exclusive = fields.exclusive;
        dirty = true;
      }
      if (fields.occurredAt && (!existing.lastOccurredAt || fields.occurredAt > existing.lastOccurredAt)) {
        existing.lastOccurredAt = fields.occurredAt;
        dirty = true;
      }
      if (dirty) await factRepo.save(existing);
      return existing.id;
    }
    try {
      const created = await factRepo.save(
        factRepo.create({
          userId,
          personEntityId: fields.personEntityId,
          personName: fields.personName,
          subjectKey: fields.subjectKey,
          attribute: fields.attribute,
          normalizedAttribute: fields.normalizedAttribute,
          value: fields.value,
          normalizedValue: fields.normalizedValue,
          exclusive: fields.exclusive,
          supersededByFactId: null,
          supersededAt: null,
          lastOccurredAt: fields.occurredAt,
        }),
      );
      return created.id;
    } catch (err) {
      // Lost a race on the dedupe unique index — re-read and use the winner.
      if (!isUniqueViolation(err)) throw err;
      const winner = await factRepo.findOne({ where });
      if (!winner) throw err;
      return winner.id;
    }
  }

  /** One citation per (extraction, fact); idempotent on re-runs/backfills. */
  private async upsertCitation(
    citationRepo: Repository<PersonalFactCitationEntity>,
    userId: string,
    inboxItemId: string,
    extractionId: string,
    factId: string,
    candidate: FactCandidate,
  ): Promise<void> {
    const existing = await citationRepo.findOne({ where: { extractionId, factId } });
    if (existing) return;
    try {
      await citationRepo.save(
        citationRepo.create({
          userId,
          inboxItemId,
          extractionId,
          factId,
          quote: candidate.quote,
          startSeconds: candidate.startSeconds,
        }),
      );
    } catch (err) {
      // Concurrent worker won the (extraction, fact) race — the citation exists.
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /**
   * The user's known `person` contacts (canonical display names), offered to the
   * model as spelling hints so a fact's subject resolves to a registry entity.
   */
  async knownPeople(userId: string): Promise<{ name: string }[]> {
    const rows = await this.entities.find({ where: { userId, type: 'person' } });
    return rows
      .map((r) => ({ name: r.canonicalName }))
      .filter((p) => p.name.trim().length > 0);
  }

  /** Named `person` registry entities keyed by normalized name, for linking. */
  private async personEntities(userId: string): Promise<Map<string, string>> {
    const rows = await this.entities.find({ where: { userId, type: 'person' } });
    const map = new Map<string, string>();
    for (const row of rows) {
      // First writer wins so linking is stable when two rows normalize alike.
      if (!map.has(row.normalizedName)) map.set(row.normalizedName, row.id);
    }
    return map;
  }

  // ---- Read models ----

  /**
   * The user's personal facts, optionally scoped to one person entity and
   * (by default) hiding superseded facts. Sorted by subject then most-recent
   * activity. Facts with zero live citations are hidden — ghosts a re-run with
   * fewer facts, or an item delete, left behind; the rows are kept so a later
   * mention can still dedupe onto them.
   */
  async list(userId: string, query: FactListQuery): Promise<PersonalFactDto[]> {
    const rows = await this.facts.find({
      where: {
        userId,
        ...(query.personEntityId ? { personEntityId: query.personEntityId } : {}),
      },
    });
    if (rows.length === 0) return [];
    const current = await this.currentCitations(rows.map((r) => r.id));
    return rows
      .filter((r) => query.includeSuperseded || r.supersededByFactId === null)
      .map((row) => this.toDto(row, current.get(row.id) ?? []))
      .filter((dto) => dto.citationCount > 0)
      .sort(byPersonThenRecent);
  }

  /**
   * An item's facts tab: the latest `facts` extraction's status plus the facts
   * it cited (with this recording's quote/segment and whether each has since
   * been superseded).
   */
  async getItemFacts(item: {
    extractions: ExtractedPayloadEntity[] | undefined;
  }): Promise<ItemFactsResponse> {
    const extraction = latestOfKind(item.extractions ?? [], 'facts');
    if (!extraction) {
      return { status: null, facts: [], model: null, error: null, createdAt: null, completedAt: null };
    }
    const citations = await this.citations.find({ where: { extractionId: extraction.id } });
    const factById = await this.factsById(citations.map((c) => c.factId));
    const facts: FactCitationDto[] = citations
      .map((c) => {
        const fact = factById.get(c.factId);
        if (!fact) return null;
        return {
          factId: fact.id,
          personEntityId: fact.personEntityId,
          personName: fact.personName,
          attribute: fact.attribute,
          value: fact.value,
          superseded: fact.supersededByFactId !== null,
          quote: c.quote,
          startSeconds: c.startSeconds,
        } satisfies FactCitationDto;
      })
      .filter((f): f is FactCitationDto => f !== null);
    return {
      status: extraction.status,
      facts,
      model: parsePayload(extraction.content)?.model ?? null,
      error: extraction.error,
      createdAt: iso(extraction.createdAt),
      completedAt: iso(extraction.completedAt),
    };
  }

  /**
   * Current source-item citations per fact — restricted to each item's latest
   * succeeded `facts` extraction, exactly like the list read model — reduced to
   * the fields a citation deep link needs (item id, quote, segment start). The
   * person dossier (JJ-24) uses this to cite each fact back to its recordings
   * without re-implementing the supersede-aware citation aggregation.
   */
  async citationRefs(
    factIds: string[],
  ): Promise<Map<string, { inboxItemId: string; quote: string | null; startSeconds: number | null }[]>> {
    const byFact = await this.currentCitations(factIds);
    const result = new Map<
      string,
      { inboxItemId: string; quote: string | null; startSeconds: number | null }[]
    >();
    for (const [factId, rows] of byFact) {
      // Newest recording first, deduped to one citation per source item.
      const byItem = new Map<string, PersonalFactCitationEntity>();
      for (const row of rows) {
        const current = byItem.get(row.inboxItemId);
        if (!current || row.createdAt > current.createdAt) byItem.set(row.inboxItemId, row);
      }
      result.set(
        factId,
        [...byItem.values()]
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((row) => ({
            inboxItemId: row.inboxItemId,
            quote: row.quote,
            startSeconds: row.startSeconds,
          })),
      );
    }
    return result;
  }

  private async factsById(ids: string[]): Promise<Map<string, PersonalFactEntity>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.facts.find({ where: { id: In(unique) } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Citations per fact, restricted to each inbox item's latest succeeded `facts`
   * extraction — so reprocessing supersedes old citations and counts stay honest
   * (mirrors the tasks registry + entity-mention aggregation).
   */
  private async currentCitations(
    factIds: string[],
  ): Promise<Map<string, PersonalFactCitationEntity[]>> {
    const result = new Map<string, PersonalFactCitationEntity[]>();
    if (factIds.length === 0) return result;
    const rows = await this.citations.find({ where: { factId: In(factIds) } });
    if (rows.length === 0) return result;

    const itemIds = [...new Set(rows.map((r) => r.inboxItemId))];
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'facts', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));

    for (const row of rows) {
      if (!latestExtractionIds.has(row.extractionId)) continue;
      const list = result.get(row.factId) ?? [];
      list.push(row);
      result.set(row.factId, list);
    }
    return result;
  }

  private toDto(row: PersonalFactEntity, citations: PersonalFactCitationEntity[]): PersonalFactDto {
    const itemIds = new Set(citations.map((c) => c.inboxItemId));
    const lastSeen = citations.reduce<Date | null>(
      (max, c) => (max === null || c.createdAt > max ? c.createdAt : max),
      null,
    );
    return {
      id: row.id,
      personEntityId: row.personEntityId,
      personName: row.personName,
      attribute: row.attribute,
      value: row.value,
      exclusive: row.exclusive,
      supersededByFactId: row.supersededByFactId,
      supersededAt: row.supersededAt,
      active: row.supersededByFactId === null,
      citationCount: itemIds.size,
      firstSeenAt: row.createdAt.toISOString(),
      lastSeenAt: (lastSeen ?? row.updatedAt ?? row.createdAt).toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Group by subject name, then newest activity first. */
function byPersonThenRecent(a: PersonalFactDto, b: PersonalFactDto): number {
  const name = a.personName.localeCompare(b.personName);
  if (name !== 0) return name;
  const attr = a.attribute.localeCompare(b.attribute);
  if (attr !== 0) return attr;
  return b.lastSeenAt.localeCompare(a.lastSeenAt);
}

/** Normalization key: lowercased, whitespace-collapsed, trailing punctuation dropped. */
export function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,]+$/g, '')
    .trim();
}

/** Trim + hard-cap a model-supplied string so stored values stay bounded. */
function clamp(value: string, maxChars: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505, better-sqlite3 a SQLITE_CONSTRAINT* code /
 * "UNIQUE constraint failed" message. Anything else must propagate. Mirrors the
 * tasks/commitments/entity-registry helper.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parsePayload(content: string | null) {
  if (!content) return null;
  try {
    const parsed = factExtractionPayloadSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

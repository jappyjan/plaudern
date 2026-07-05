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
  quote: string | null;
  startSeconds: number | null;
}

/**
 * Owns the per-user personal-facts store (JJ-31): resolving extracted candidate
 * facts to a subject (a registry `person` entity when the name matches, else a
 * raw name), deduplicating them into `personal_facts` rows with
 * `personal_fact_citations` edges, and maintaining APPEND-ONLY SUPERSESSION —
 * within a (subject, attribute) group the fact backed by the most recent
 * recording is active; the rest point at it via `supersededByFactId` and are
 * kept as history. Also serves the read models (per-person list, an item's
 * facts tab).
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
   * for every (subject, attribute) the batch touched. Returns the number of
   * distinct facts the item was linked to.
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
        quote: raw.quote ? clamp(raw.quote, MAX_QUOTE_CHARS) : null,
        startSeconds: raw.startSeconds,
      });
      if (cleaned.length >= MAX_FACTS_PER_EXTRACTION) break;
    }
    if (cleaned.length === 0) return 0;

    const personByName = await this.personEntities(userId);
    const cited = new Set<string>();
    const touchedGroups = new Map<string, { subjectKey: string; normalizedAttribute: string }>();

    for (const candidate of cleaned) {
      const normalizedPerson = normalize(candidate.person);
      const personEntityId = personByName.get(normalizedPerson) ?? null;
      const subjectKey = personEntityId ? `e:${personEntityId}` : `n:${normalizedPerson}`;
      const normalizedAttribute = normalize(candidate.attribute);
      const normalizedValue = normalize(candidate.value);

      const factId = await this.resolveFact(userId, {
        personEntityId,
        personName: candidate.person,
        subjectKey,
        attribute: candidate.attribute,
        normalizedAttribute,
        value: candidate.value,
        normalizedValue,
        occurredAt: occurredAt ?? null,
      });
      await this.upsertCitation(userId, inboxItemId, extractionId, factId, candidate);
      cited.add(factId);
      touchedGroups.set(`${subjectKey}::${normalizedAttribute}`, { subjectKey, normalizedAttribute });
    }

    for (const group of touchedGroups.values()) {
      await this.recomputeSupersession(userId, group.subjectKey, group.normalizedAttribute);
    }
    return cited.size;
  }

  /** Find the existing fact row for this (subject, attribute, value) or create it. */
  private async resolveFact(
    userId: string,
    fields: {
      personEntityId: string | null;
      personName: string;
      subjectKey: string;
      attribute: string;
      normalizedAttribute: string;
      value: string;
      normalizedValue: string;
      occurredAt: string | null;
    },
  ): Promise<string> {
    const where = {
      userId,
      subjectKey: fields.subjectKey,
      normalizedAttribute: fields.normalizedAttribute,
      normalizedValue: fields.normalizedValue,
    };
    const existing = await this.facts.findOne({ where });
    if (existing) {
      // Refresh mutable, non-identity fields: adopt a newer linkage / spelling
      // and advance recency so supersession sees the latest supporting instant.
      let dirty = false;
      if (fields.personEntityId && existing.personEntityId !== fields.personEntityId) {
        existing.personEntityId = fields.personEntityId;
        dirty = true;
      }
      if (fields.occurredAt && (!existing.lastOccurredAt || fields.occurredAt > existing.lastOccurredAt)) {
        existing.lastOccurredAt = fields.occurredAt;
        dirty = true;
      }
      if (dirty) await this.facts.save(existing);
      return existing.id;
    }
    try {
      const created = await this.facts.save(
        this.facts.create({
          userId,
          personEntityId: fields.personEntityId,
          personName: fields.personName,
          subjectKey: fields.subjectKey,
          attribute: fields.attribute,
          normalizedAttribute: fields.normalizedAttribute,
          value: fields.value,
          normalizedValue: fields.normalizedValue,
          supersededByFactId: null,
          supersededAt: null,
          lastOccurredAt: fields.occurredAt,
        }),
      );
      return created.id;
    } catch (err) {
      // Lost a race on the dedupe unique index — re-read and use the winner.
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.facts.findOne({ where });
      if (!winner) throw err;
      return winner.id;
    }
  }

  /** One citation per (extraction, fact); idempotent on re-runs/backfills. */
  private async upsertCitation(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    factId: string,
    candidate: FactCandidate,
  ): Promise<void> {
    const existing = await this.citations.findOne({ where: { extractionId, factId } });
    if (existing) return;
    try {
      await this.citations.save(
        this.citations.create({
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
   * Recompute supersession for one (subject, attribute) group: the fact backed
   * by the most recent recording (`lastOccurredAt`, tiebroken by newest
   * `createdAt` then id) is the ACTIVE one; every other fact in the group points
   * at it via `supersededByFactId` and is stamped `supersededAt`. Deterministic
   * and idempotent — re-running yields the same active fact. Superseded rows are
   * NEVER deleted; a later mention that makes an old value current simply flips
   * the pointers back.
   */
  private async recomputeSupersession(
    userId: string,
    subjectKey: string,
    normalizedAttribute: string,
  ): Promise<void> {
    const group = await this.facts.find({
      where: { userId, subjectKey, normalizedAttribute },
    });
    if (group.length === 0) return;
    const winner = group.slice().sort(byRecencyDesc)[0];
    const now = new Date().toISOString();
    for (const fact of group) {
      const shouldBeActive = fact.id === winner.id;
      if (shouldBeActive) {
        if (fact.supersededByFactId !== null || fact.supersededAt !== null) {
          fact.supersededByFactId = null;
          fact.supersededAt = null;
          await this.facts.save(fact);
        }
      } else if (fact.supersededByFactId !== winner.id) {
        fact.supersededByFactId = winner.id;
        fact.supersededAt = fact.supersededAt ?? now;
        await this.facts.save(fact);
      }
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

/** Newest supporting recording first (nulls last), tiebroken by newest row then id. */
function byRecencyDesc(a: PersonalFactEntity, b: PersonalFactEntity): number {
  const ao = a.lastOccurredAt ?? '';
  const bo = b.lastOccurredAt ?? '';
  if (ao !== bo) return ao < bo ? 1 : -1;
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return b.createdAt.getTime() - a.createdAt.getTime();
  return a.id < b.id ? 1 : -1;
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

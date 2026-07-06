import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  type EntityDetailDto,
  type EntityType,
  type ExtractedEntity,
  type RegistryEntityDto,
  isRegistryEntityType,
  sanitizeAliases,
} from '@plaudern/contracts';
import {
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { exactContactMatch, normalize } from './contact-matching';

/**
 * Owns the per-user entity registry (JJ-32): normalizing/deduping extracted
 * entities into `entities` rows, recording `entity_mentions` edges, and the
 * manual contact-link operations (link/unlink/convert, JJ-63). At ingest
 * only an exact (diacritic-folded) name match links a `person` to the contact
 * book — everything fuzzier is the EntityContactResolverService's job, which
 * weighs recordings and the knowledge graph. Also serves the read models
 * (list, detail) — restricting mention aggregates to each item's LATEST
 * succeeded `entities` extraction so append-only reprocessing supersedes old
 * links, exactly like the diarization contact book.
 *
 * The upsert path consults the JJ-63 correction tables so manual corrections
 * survive re-extraction: suppressed (deleted) names are skipped entirely, and
 * merged-away/renamed names resolve — via `entity_aliases` — onto their
 * surviving entity instead of resurrecting a duplicate. Rename/retype, merge,
 * and delete themselves live in EntitiesCorrectionService (transactional).
 */
@Injectable()
export class EntitiesRegistryService {
  constructor(
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(EntityMentionEntity)
    private readonly mentions: Repository<EntityMentionEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(EntityAliasEntity)
    private readonly aliasRecords: Repository<EntityAliasEntity>,
    @InjectRepository(EntitySuppressionEntity)
    private readonly suppressions: Repository<EntitySuppressionEntity>,
  ) {}

  /**
   * Normalize + dedupe a batch of extracted entities into the registry and
   * append one mention per distinct entity for this extraction. Returns the
   * number of distinct registry entities the item was linked to.
   */
  async ingest(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    extracted: ExtractedEntity[],
  ): Promise<number> {
    // Collapse duplicates within the batch first (same type + normalized name),
    // unioning their surface forms — so one recording yields one mention each.
    const byKey = new Map<
      string,
      { entity: ExtractedEntity; surfaceForms: Set<string>; surfaceForm: string }
    >();
    for (const raw of extracted) {
      const name = raw.name.trim();
      if (!name) continue;
      // Transient values (dates, amounts) are not identities — never register
      // them, so they can't become graph nodes, relation endpoints, or the
      // co-occurrence noise that buries the meaningful edges.
      if (!isRegistryEntityType(raw.type)) continue;
      const key = `${raw.type}:${normalize(name)}`;
      const existing = byKey.get(key);
      const surfaceForms = existing?.surfaceForms ?? new Set<string>();
      for (const mention of [name, ...raw.mentions]) {
        const trimmed = mention.trim();
        if (trimmed) surfaceForms.add(trimmed);
      }
      if (!existing) {
        // The mention records the form actually observed in the recording
        // (contract: entityMentionSchema.surfaceForm), so prefer the model's
        // first reported surface form over the canonical name.
        const observed = raw.mentions.map((m) => m.trim()).find(Boolean) ?? name;
        byKey.set(key, { entity: { ...raw, name }, surfaceForms, surfaceForm: observed });
      }
    }
    if (byKey.size === 0) return 0;

    // Only exact (folded) name equality links at ingest; the contact resolver
    // runs right after extraction with the full evidence (voices, graph).
    const contacts = await this.profiles.find({ where: { userId } });
    let linked = 0;
    for (const { entity, surfaceForms, surfaceForm } of byKey.values()) {
      const registryEntity = await this.upsertEntity(
        userId,
        entity.type,
        entity.name,
        [...surfaceForms],
        contacts,
      );
      // Suppressed (deleted) names resolve to null — no entity, no mention, so
      // the correction stays durable across re-extraction and backfills.
      if (!registryEntity) continue;
      await this.upsertMention(
        userId,
        inboxItemId,
        extractionId,
        registryEntity.id,
        surfaceForm,
      );
      linked += 1;
    }
    return linked;
  }

  /**
   * Registry list, optionally filtered to one type, newest activity first.
   * Rows no current extraction mentions (ghosts after reprocessing/deletes)
   * are hidden unless `includeUnreferenced` is set.
   */
  async list(
    userId: string,
    type?: EntityType,
    includeUnreferenced = false,
  ): Promise<RegistryEntityDto[]> {
    const rows = await this.entities.find({
      where: type ? { userId, type } : { userId },
    });
    if (rows.length === 0) return [];
    const current = await this.currentMentions(rows.map((r) => r.id));
    const names = await this.profileNames(rows);
    return rows
      .map((row) => this.toDto(row, current.get(row.id) ?? [], names))
      .filter((dto) => includeUnreferenced || dto.mentionCount > 0)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** One registry entity with its mentions (from the latest extraction/item). */
  async detail(userId: string, id: string): Promise<EntityDetailDto> {
    const row = await this.getOwned(userId, id);
    const mentions = (await this.currentMentions([id])).get(id) ?? [];
    const names = await this.profileNames([row]);
    return {
      ...this.toDto(row, mentions, names),
      mentions: mentions
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((m) => ({
          id: m.id,
          inboxItemId: m.inboxItemId,
          surfaceForm: m.surfaceForm,
          createdAt: m.createdAt.toISOString(),
        })),
    };
  }

  /**
   * Current mention inbox-item ids per entity, in ONE bulk pass — the source
   * items each entity is derived from, for external-surface sensitivity gating
   * (JJ-78). Restricted, like the read models, to each item's LATEST succeeded
   * `entities` extraction; entities with no current mention map to an empty
   * array. Entity ids are re-scoped to the user here, so a foreign id yields no
   * items rather than leaking cross-user mentions.
   */
  async mentionItemIds(userId: string, entityIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (entityIds.length === 0) return map;
    const rows = await this.entities.find({ where: { id: In(entityIds), userId } });
    const current = await this.currentMentions(rows.map((r) => r.id));
    for (const row of rows) {
      map.set(row.id, [...new Set((current.get(row.id) ?? []).map((m) => m.inboxItemId))]);
    }
    return map;
  }

  /** Manually link a `person` entity to a contact-book voice profile. */
  async linkContact(userId: string, id: string, voiceProfileId: string): Promise<EntityDetailDto> {
    const row = await this.getOwned(userId, id);
    if (row.type !== 'person') {
      throw new BadRequestException('only person entities can link to a contact');
    }
    const profile = await this.profiles.findOne({ where: { id: voiceProfileId, userId } });
    if (!profile) throw new NotFoundException('voice profile not found');
    row.voiceProfileId = profile.id;
    row.voiceProfileLinkOrigin = 'manual';
    await this.entities.save(row);
    return this.detail(userId, id);
  }

  /**
   * Remove an entity's contact link and suppress auto-linking for it — an
   * explicit unlink is a correction, so background sweeps and future ingests
   * must not silently redo what the user undid. A manual link stays possible.
   */
  async unlinkContact(userId: string, id: string): Promise<EntityDetailDto> {
    const row = await this.getOwned(userId, id);
    if (row.type !== 'person') {
      throw new BadRequestException('only person entities can link to a contact');
    }
    row.voiceProfileId = null;
    row.voiceProfileLinkOrigin = 'suppressed';
    await this.entities.save(row);
    return this.detail(userId, id);
  }

  /**
   * Promote a `person` entity to a real contact: create a confirmed voice
   * profile named after it (no voiceprint — one attaches when the person is
   * first heard and merged) and link the entity to it.
   */
  async convertToContact(userId: string, id: string): Promise<EntityDetailDto> {
    const row = await this.getOwned(userId, id);
    if (row.type !== 'person') {
      throw new BadRequestException('only person entities can become a contact');
    }
    if (row.voiceProfileId) {
      throw new BadRequestException('entity is already linked to a contact');
    }
    const profile = await this.profiles.save(
      this.profiles.create({
        userId,
        name: row.canonicalName,
        status: 'confirmed',
      }),
    );
    row.voiceProfileId = profile.id;
    row.voiceProfileLinkOrigin = 'manual';
    await this.entities.save(row);
    return this.detail(userId, id);
  }

  /**
   * The registry entities mentioned by the item's latest succeeded `entities`
   * extraction — the legal relation endpoints for the `relations` extractor.
   */
  async entitiesForItem(userId: string, inboxItemId: string): Promise<EntityRegistryEntity[]> {
    const extractionRows = await this.extractions.find({
      where: { inboxItemId, kind: 'entities', status: 'succeeded' },
    });
    const latest = extractionRows
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!latest) return [];
    const mentions = await this.mentions.find({ where: { extractionId: latest.id } });
    if (mentions.length === 0) return [];
    return this.entities.find({
      where: { id: In(mentions.map((m) => m.entityId)), userId },
    });
  }

  /**
   * Find or create the registry row for (userId, type, normalizedName),
   * accreting any new surface forms as aliases and linking a `person` to an
   * exactly-matching named voice profile (respecting a `suppressed` origin).
   *
   * Consults the JJ-63 correction tables so manual edits survive re-extraction:
   * a suppressed (deleted) name returns null (skip it entirely); a merged-away
   * or renamed name resolves — via `entity_aliases` — onto the surviving entity
   * instead of resurrecting a duplicate.
   */
  private async upsertEntity(
    userId: string,
    type: EntityType,
    name: string,
    surfaceForms: string[],
    contacts: VoiceProfileEntity[],
  ): Promise<EntityRegistryEntity | null> {
    const normalizedName = normalize(name);
    // Deleted/suppressed names must never come back.
    const suppressed = await this.suppressions.findOne({
      where: { userId, type, normalizedName },
    });
    if (suppressed) return null;

    let row = await this.entities.findOne({ where: { userId, type, normalizedName } });
    // Not a live entity under this exact name — but it may be a merged-away or
    // renamed spelling that must resolve onto its surviving entity.
    if (!row) {
      const alias = await this.aliasRecords.findOne({
        where: { userId, type, normalizedName },
      });
      if (alias) {
        const target = await this.entities.findOne({ where: { id: alias.entityId, userId } });
        // Cross-type redirect: the name was merged/renamed into an entity that
        // was later retyped. Record the mention against the survivor (no
        // resurrected duplicate) but do NOT mutate it — a person-extraction
        // must never rename, alias-accrete, or voice-link an organization.
        if (target && target.type !== type) return target;
        row = target;
      }
    }
    if (!row) {
      row = this.entities.create({
        userId,
        type,
        canonicalName: name,
        normalizedName,
        aliases: [],
        voiceProfileId: null,
        voiceProfileLinkOrigin: null,
      });
    }

    const aliases = new Set(row.aliases ?? []);
    for (const form of surfaceForms) if (form) aliases.add(form);
    // Adopt the longer spelling as canonical (e.g. "Angela Merkel" over "Angela").
    if (name.length > row.canonicalName.length) row.canonicalName = name;
    // Drop grammar the model dumped as surface forms (pronouns, articles,
    // generic role nouns) and the canonical name itself before it becomes a
    // displayed "Also known as" alias.
    row.aliases = sanitizeAliases(row.canonicalName, [...aliases]);

    // Guarded on the ROW's type (not the requested one) so a voice link can
    // never be written onto a non-person, whatever path resolved the row.
    if (
      row.type === 'person' &&
      !row.voiceProfileId &&
      row.voiceProfileLinkOrigin !== 'suppressed'
    ) {
      const profileId = exactContactMatch([row.canonicalName, ...row.aliases], contacts);
      if (profileId) {
        row.voiceProfileId = profileId;
        row.voiceProfileLinkOrigin = 'auto';
      }
    }

    try {
      return await this.entities.save(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race on the unique index — re-read and merge onto the winner.
      const winner = await this.entities.findOne({
        where: { userId, type, normalizedName },
      });
      if (!winner) throw new Error('failed to upsert entity');
      const merged = new Set([...(winner.aliases ?? []), ...row.aliases]);
      winner.aliases = sanitizeAliases(winner.canonicalName, [...merged]);
      if (!winner.voiceProfileId && row.voiceProfileId) {
        winner.voiceProfileId = row.voiceProfileId;
        winner.voiceProfileLinkOrigin = row.voiceProfileLinkOrigin;
      }
      return this.entities.save(winner);
    }
  }

  /** One mention row per (extraction, entity); idempotent on re-runs. */
  private async upsertMention(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    entityId: string,
    surfaceForm: string,
  ): Promise<void> {
    const existing = await this.mentions.findOne({ where: { extractionId, entityId } });
    if (existing) return;
    await this.mentions.save(
      this.mentions.create({ userId, inboxItemId, extractionId, entityId, surfaceForm }),
    );
  }

  private async getOwned(userId: string, id: string): Promise<EntityRegistryEntity> {
    const row = await this.entities.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('entity not found');
    return row;
  }

  /** Display names of the profiles linked by the given rows, keyed by id. */
  private async profileNames(rows: EntityRegistryEntity[]): Promise<Map<string, string | null>> {
    const ids = [...new Set(rows.map((r) => r.voiceProfileId).filter((id): id is string => !!id))];
    const names = new Map<string, string | null>();
    if (ids.length === 0) return names;
    const profiles = await this.profiles.find({ where: { id: In(ids) } });
    for (const profile of profiles) names.set(profile.id, profile.name);
    return names;
  }

  /**
   * Mentions per entity, restricted to each inbox item's latest succeeded
   * `entities` extraction — so reprocessing supersedes old mentions and counts
   * stay honest.
   */
  private async currentMentions(
    entityIds: string[],
  ): Promise<Map<string, EntityMentionEntity[]>> {
    const result = new Map<string, EntityMentionEntity[]>();
    if (entityIds.length === 0) return result;
    const rows = await this.mentions.find({ where: { entityId: In(entityIds) } });
    if (rows.length === 0) return result;

    const itemIds = [...new Set(rows.map((r) => r.inboxItemId))];
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'entities', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));

    for (const row of rows) {
      if (!latestExtractionIds.has(row.extractionId)) continue;
      const list = result.get(row.entityId) ?? [];
      list.push(row);
      result.set(row.entityId, list);
    }
    return result;
  }

  private toDto(
    row: EntityRegistryEntity,
    mentions: EntityMentionEntity[],
    profileNames: Map<string, string | null>,
  ): RegistryEntityDto {
    const itemIds = new Set(mentions.map((m) => m.inboxItemId));
    const lastSeen = mentions.reduce<Date | null>(
      (max, m) => (max === null || m.createdAt > max ? m.createdAt : max),
      null,
    );
    return {
      id: row.id,
      type: row.type,
      canonicalName: row.canonicalName,
      aliases: row.aliases ?? [],
      voiceProfileId: row.voiceProfileId,
      voiceProfileLinkOrigin: row.voiceProfileLinkOrigin,
      voiceProfileName: row.voiceProfileId
        ? (profileNames.get(row.voiceProfileId) ?? null)
        : null,
      mentionCount: itemIds.size,
      firstSeenAt: row.createdAt.toISOString(),
      lastSeenAt: (lastSeen ?? row.createdAt).toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505 (unique_violation), better-sqlite3 a
 * SQLITE_CONSTRAINT* code / "UNIQUE constraint failed" message. Anything else
 * (connection loss, bad SQL, …) is a real error and must propagate.
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

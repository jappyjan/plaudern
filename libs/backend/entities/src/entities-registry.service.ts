import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  EntityDetailDto,
  EntityType,
  ExtractedEntity,
  RegistryEntityDto,
  UpdateEntityRequest,
} from '@plaudern/contracts';
import {
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { exactContactMatch, normalize } from './contact-matching';

/**
 * Owns the per-user entity registry (JJ-32): normalizing/deduping extracted
 * entities into `entities` rows, recording `entity_mentions` edges, and the
 * manual contact-link operations (link/unlink/convert/edit, JJ-63). At ingest
 * only an exact (diacritic-folded) name match links a `person` to the contact
 * book — everything fuzzier is the EntityContactResolverService's job, which
 * weighs recordings and the knowledge graph. Also serves the read models
 * (list, detail) — restricting mention aggregates to each item's LATEST
 * succeeded `entities` extraction so append-only reprocessing supersedes old
 * links, exactly like the diarization contact book.
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
   * Correct a registry entity (JJ-63): rename and/or re-type it. A rename
   * moves the dedupe key, so the old canonical name is kept as an alias;
   * re-typing away from `person` drops any contact link. Colliding with an
   * existing (type, name) row is rejected — merging is separate tooling.
   */
  async update(userId: string, id: string, req: UpdateEntityRequest): Promise<EntityDetailDto> {
    const row = await this.getOwned(userId, id);
    if (req.canonicalName !== undefined) {
      const name = req.canonicalName.trim();
      const normalizedName = normalize(name);
      if (normalizedName !== row.normalizedName) {
        const aliases = new Set(row.aliases ?? []);
        aliases.add(row.canonicalName);
        row.aliases = [...aliases];
      }
      row.canonicalName = name;
      row.normalizedName = normalizedName;
    }
    if (req.type !== undefined && req.type !== row.type) {
      row.type = req.type;
      if (req.type !== 'person') {
        row.voiceProfileId = null;
        row.voiceProfileLinkOrigin = null;
      }
    }
    try {
      await this.entities.save(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      throw new ConflictException(
        'another entity with this type and name already exists',
      );
    }
    return this.detail(userId, id);
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
   * exactly-matching named voice profile.
   */
  private async upsertEntity(
    userId: string,
    type: EntityType,
    name: string,
    surfaceForms: string[],
    contacts: VoiceProfileEntity[],
  ): Promise<EntityRegistryEntity> {
    const normalizedName = normalize(name);
    let row = await this.entities.findOne({ where: { userId, type, normalizedName } });
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
    row.aliases = [...aliases];
    // Adopt the longer spelling as canonical (e.g. "Angela Merkel" over "Angela").
    if (name.length > row.canonicalName.length) row.canonicalName = name;

    if (
      type === 'person' &&
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
      winner.aliases = [...merged];
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

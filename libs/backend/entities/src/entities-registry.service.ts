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
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';

/** A named contact-book profile, prepared for name matching. */
export interface ContactCandidate {
  id: string;
  /** normalize()d profile name. */
  normalized: string;
}

/**
 * Owns the per-user entity registry (JJ-32): normalizing/deduping extracted
 * entities into `entities` rows, recording `entity_mentions` edges, and linking
 * `person` entities to the voice-profile contact book — automatically (exact
 * name, or partial name disambiguated by who actually speaks in the recording)
 * and manually (link/unlink/convert, JJ-63). Also serves the read models
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
    @InjectRepository(SpeakerOccurrenceEntity)
    private readonly occurrences: Repository<SpeakerOccurrenceEntity>,
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

    const contacts = await this.contactCandidates(userId);
    // The recording's own speakers are the disambiguation context: a partial
    // name match ("Detlef" → "Detlef Müller") is only trusted outright when
    // unique, otherwise the candidate actually speaking in this item wins.
    const speakerIds = await this.speakersForItems([inboxItemId]);
    let linked = 0;
    for (const { entity, surfaceForms, surfaceForm } of byKey.values()) {
      const registryEntity = await this.upsertEntity(
        userId,
        entity.type,
        entity.name,
        [...surfaceForms],
        contacts,
        speakerIds,
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
   * Sweep every unlinked (and not suppressed) person entity and auto-link the
   * ones that now match a named contact — e.g. after a speaker finally gets a
   * name in the contact book. Ambiguous partial matches fall back to the
   * recordings the entity is mentioned in: a candidate who actually speaks
   * there wins. Returns how many entities gained a link.
   */
  async autoLinkContacts(userId: string): Promise<number> {
    const rows = await this.entities.find({ where: { userId, type: 'person' as EntityType } });
    const unlinked = rows.filter(
      (r) => !r.voiceProfileId && r.voiceProfileLinkOrigin !== 'suppressed',
    );
    if (unlinked.length === 0) return 0;
    const contacts = await this.contactCandidates(userId);
    if (contacts.length === 0) return 0;

    const current = await this.currentMentions(unlinked.map((r) => r.id));
    let linked = 0;
    for (const row of unlinked) {
      const names = [row.normalizedName, ...(row.aliases ?? []).map(normalize)];
      let profileId = resolveContactLink(names, contacts, null);
      if (!profileId) {
        const itemIds = [...new Set((current.get(row.id) ?? []).map((m) => m.inboxItemId))];
        if (itemIds.length > 0) {
          const speakerIds = await this.speakersForItems(itemIds);
          profileId = resolveContactLink(names, contacts, speakerIds);
        }
      }
      if (!profileId) continue;
      row.voiceProfileId = profileId;
      row.voiceProfileLinkOrigin = 'auto';
      await this.entities.save(row);
      linked += 1;
    }
    return linked;
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
   * accreting any new surface forms as aliases and (re)linking a `person` to a
   * matching named voice profile.
   */
  private async upsertEntity(
    userId: string,
    type: EntityType,
    name: string,
    surfaceForms: string[],
    contacts: ContactCandidate[],
    speakerIds: Set<string>,
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
      const names = [row.normalizedName, ...row.aliases.map(normalize)];
      const profileId = resolveContactLink(names, contacts, speakerIds);
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

  /** Named voice profiles prepared for person auto-linking. */
  private async contactCandidates(userId: string): Promise<ContactCandidate[]> {
    const rows = await this.profiles.find({ where: { userId } });
    return rows
      .filter((row) => row.name)
      .map((row) => ({ id: row.id, normalized: normalize(row.name as string) }));
  }

  /**
   * Voice profiles that speak in the given items, restricted to each item's
   * latest succeeded diarization — the "who is actually in the room" context
   * used to disambiguate partial name matches.
   */
  private async speakersForItems(itemIds: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    if (itemIds.length === 0) return result;
    const rows = await this.occurrences.find({ where: { inboxItemId: In(itemIds) } });
    if (rows.length === 0) return result;
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'diarization', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));
    for (const row of rows) {
      if (latestExtractionIds.has(row.extractionId)) result.add(row.voiceProfileId);
    }
    return result;
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

/** Normalization key: lowercased, whitespace-collapsed. Alias/case matching. */
export function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Pick the contact a person entity should auto-link to, or null when nothing
 * matches unambiguously. `names` are the entity's normalize()d name forms
 * (canonical + aliases). Exact full-name equality wins outright; otherwise a
 * token-boundary partial match ("detlef" ↔ "detlef müller") links only when it
 * is unique — or, given `speakerIds` (who actually speaks in the recording(s)
 * involved), when exactly one candidate is among the speakers.
 */
export function resolveContactLink(
  names: string[],
  contacts: ContactCandidate[],
  speakerIds: Set<string> | null,
): string | null {
  const nameSet = new Set(names.filter(Boolean));
  if (nameSet.size === 0 || contacts.length === 0) return null;

  // First-writer-wins so linking is stable when two profiles share a name.
  const exact = contacts.find((c) => nameSet.has(c.normalized));
  if (exact) return exact.id;

  const partialIds = new Set<string>();
  const partial: ContactCandidate[] = [];
  for (const contact of contacts) {
    const matches = [...nameSet].some(
      (name) =>
        name.startsWith(`${contact.normalized} `) || contact.normalized.startsWith(`${name} `),
    );
    if (matches && !partialIds.has(contact.id)) {
      partialIds.add(contact.id);
      partial.push(contact);
    }
  }
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1 && speakerIds) {
    const speaking = partial.filter((c) => speakerIds.has(c.id));
    if (speaking.length === 1) return speaking[0].id;
  }
  return null;
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

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  EntityDetailDto,
  EntityType,
  ExtractedEntity,
  RegistryEntityDto,
} from '@plaudern/contracts';
import {
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';

/**
 * Owns the per-user entity registry (JJ-32): normalizing/deduping extracted
 * entities into `entities` rows, recording `entity_mentions` edges, and linking
 * `person` entities to the voice-profile contact book. Also serves the read
 * models (list, detail) — restricting mention aggregates to each item's LATEST
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
    const byKey = new Map<string, { entity: ExtractedEntity; surfaceForms: Set<string> }>();
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
      if (!existing) byKey.set(key, { entity: { ...raw, name }, surfaceForms });
    }
    if (byKey.size === 0) return 0;

    const profilesByName = await this.namedProfiles(userId);
    let linked = 0;
    for (const { entity, surfaceForms } of byKey.values()) {
      const registryEntity = await this.upsertEntity(
        userId,
        entity.type,
        entity.name,
        [...surfaceForms],
        profilesByName,
      );
      await this.upsertMention(
        userId,
        inboxItemId,
        extractionId,
        registryEntity.id,
        entity.name,
      );
      linked += 1;
    }
    return linked;
  }

  /** Registry list, optionally filtered to one type, newest activity first. */
  async list(userId: string, type?: EntityType): Promise<RegistryEntityDto[]> {
    const rows = await this.entities.find({
      where: type ? { userId, type } : { userId },
    });
    if (rows.length === 0) return [];
    const current = await this.currentMentions(rows.map((r) => r.id));
    return rows
      .map((row) => this.toDto(row, current.get(row.id) ?? []))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** One registry entity with its mentions (from the latest extraction/item). */
  async detail(userId: string, id: string): Promise<EntityDetailDto> {
    const row = await this.entities.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('entity not found');
    const mentions = (await this.currentMentions([id])).get(id) ?? [];
    return {
      ...this.toDto(row, mentions),
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
   * Find or create the registry row for (userId, type, normalizedName),
   * accreting any new surface forms as aliases and (re)linking a `person` to a
   * matching named voice profile.
   */
  private async upsertEntity(
    userId: string,
    type: EntityType,
    name: string,
    surfaceForms: string[],
    profilesByName: Map<string, string>,
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
      });
    }

    const aliases = new Set(row.aliases ?? []);
    for (const form of surfaceForms) if (form) aliases.add(form);
    row.aliases = [...aliases];
    // Adopt the longer spelling as canonical (e.g. "Angela Merkel" over "Angela").
    if (name.length > row.canonicalName.length) row.canonicalName = name;

    if (type === 'person' && !row.voiceProfileId) {
      const profileId = profilesByName.get(normalizedName);
      if (profileId) row.voiceProfileId = profileId;
    }

    try {
      return await this.entities.save(row);
    } catch {
      // Lost a race on the unique index — re-read and merge onto the winner.
      const winner = await this.entities.findOne({
        where: { userId, type, normalizedName },
      });
      if (!winner) throw new Error('failed to upsert entity');
      const merged = new Set([...(winner.aliases ?? []), ...row.aliases]);
      winner.aliases = [...merged];
      if (!winner.voiceProfileId && row.voiceProfileId) winner.voiceProfileId = row.voiceProfileId;
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

  /** Named voice profiles keyed by normalized name, for person linking. */
  private async namedProfiles(userId: string): Promise<Map<string, string>> {
    const rows = await this.profiles.find({ where: { userId } });
    const map = new Map<string, string>();
    for (const row of rows) {
      if (!row.name) continue;
      // First writer wins so linking is stable when two profiles share a name.
      const key = normalize(row.name);
      if (!map.has(key)) map.set(key, row.id);
    }
    return map;
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

  private toDto(row: EntityRegistryEntity, mentions: EntityMentionEntity[]): RegistryEntityDto {
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

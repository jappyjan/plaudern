import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { EntityType, RelationType } from '@plaudern/contracts';
import {
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import { isUniqueViolation, normalize } from './entities-registry.service';

/**
 * Relation types whose direction carries no meaning (mirrors
 * EntityGraphService): after a merge repoints an endpoint, symmetric edges are
 * re-canonicalized smaller-id-first so A↔B and B↔A collapse onto one row,
 * matching how they were written at ingest.
 */
const SYMMETRIC_RELATION_TYPES: ReadonlySet<RelationType> = new Set([
  'related_to',
  'discussed_with',
]);

/**
 * Manual entity corrections (JJ-63): merge two entities, rename/retype one,
 * re-link a person to a voice-profile contact, and delete/suppress one. The
 * hard part is DURABILITY — every correction writes to the `entity_aliases` /
 * `entity_suppressions` side tables the registry upsert path consults, so a
 * merge/rename/delete is not undone by the next extraction run or backfill.
 *
 * Every method is user-scoped at every step. Mutations return the survivor's
 * entity id (or void); the controller re-reads the full detail read model.
 */
@Injectable()
export class EntitiesCorrectionService {
  constructor(
    @InjectRepository(EntityRegistryEntity)
    private readonly entities: Repository<EntityRegistryEntity>,
    @InjectRepository(EntityMentionEntity)
    private readonly mentions: Repository<EntityMentionEntity>,
    @InjectRepository(EntityRelationEntity)
    private readonly relations: Repository<EntityRelationEntity>,
    @InjectRepository(VoiceProfileEntity)
    private readonly profiles: Repository<VoiceProfileEntity>,
    @InjectRepository(EntityAliasEntity)
    private readonly aliasRecords: Repository<EntityAliasEntity>,
    @InjectRepository(EntitySuppressionEntity)
    private readonly suppressions: Repository<EntitySuppressionEntity>,
  ) {}

  /**
   * Merge the victim into the survivor: union aliases (+ the person's voice
   * link), repoint every mention and relation to the survivor (deduping against
   * the unique constraints, dropping survivor→survivor self-edges), record the
   * victim's names as aliases of the survivor so re-extraction resolves to it,
   * then delete the victim. Returns the survivor id.
   */
  async merge(userId: string, survivorId: string, victimId: string): Promise<string> {
    if (survivorId === victimId) {
      throw new BadRequestException('cannot merge an entity into itself');
    }
    const survivor = await this.entities.findOne({ where: { id: survivorId, userId } });
    if (!survivor) throw new NotFoundException('entity not found');
    const victim = await this.entities.findOne({ where: { id: victimId, userId } });
    if (!victim) throw new NotFoundException('entity not found');
    if (survivor.type !== victim.type) {
      throw new BadRequestException(
        'entities must be the same type to merge — change the type first, then merge',
      );
    }

    await this.repointMentions(victimId, survivorId);
    await this.repointRelations(victimId, survivorId);

    // Union the victim's known spellings onto the survivor. The user chose the
    // survivor, so its canonical name is kept; the victim's becomes an alias.
    const aliases = new Set(survivor.aliases ?? []);
    for (const alias of victim.aliases ?? []) aliases.add(alias);
    aliases.add(victim.canonicalName);
    survivor.aliases = [...aliases];
    if (!survivor.voiceProfileId && victim.voiceProfileId) {
      survivor.voiceProfileId = victim.voiceProfileId;
    }
    await this.entities.save(survivor);

    // Alias records so future extraction/backfill resolves the victim's names to
    // the survivor instead of recreating a duplicate. Existing alias rows that
    // pointed at the victim are repointed (their unique key is unchanged, so no
    // conflict is possible).
    const victimAliasRows = await this.aliasRecords.find({ where: { entityId: victimId } });
    for (const row of victimAliasRows) row.entityId = survivorId;
    if (victimAliasRows.length > 0) await this.aliasRecords.save(victimAliasRows);
    await this.recordAlias(userId, survivor.type, victim.normalizedName, survivorId, survivor.normalizedName);
    for (const alias of victim.aliases ?? []) {
      await this.recordAlias(userId, survivor.type, normalize(alias), survivorId, survivor.normalizedName);
    }

    // The victim's mentions/relations/aliases are all repointed; drop it.
    await this.entities.delete({ id: victimId, userId });
    return survivorId;
  }

  /**
   * Correct a wrong extraction: rename and/or retype. The OLD identity (old
   * name, and on retype the old type) is preserved as an alias so re-extraction
   * folds back in instead of recreating the pre-correction row. Renaming to a
   * previously suppressed name un-suppresses it. Returns the entity id.
   */
  async update(
    userId: string,
    id: string,
    changes: { canonicalName?: string; type?: EntityType },
  ): Promise<string> {
    const row = await this.entities.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('entity not found');

    const oldType = row.type;
    const oldNormalized = row.normalizedName;
    const oldCanonical = row.canonicalName;
    const newType = changes.type ?? oldType;
    const newCanonical =
      changes.canonicalName !== undefined ? changes.canonicalName.trim() : oldCanonical;
    const newNormalized =
      changes.canonicalName !== undefined ? normalize(newCanonical) : oldNormalized;

    const nameChanged = newNormalized !== oldNormalized;
    const typeChanged = newType !== oldType;

    if (nameChanged || typeChanged) {
      const clash = await this.entities.findOne({
        where: { userId, type: newType, normalizedName: newNormalized },
      });
      if (clash && clash.id !== id) {
        throw new ConflictException(
          'another entity already uses that name and type — merge into it instead',
        );
      }
      // The user explicitly wants this identity: un-suppress it and drop any
      // alias that would otherwise shadow it (a live entity always wins, but
      // keep the tables tidy).
      await this.suppressions.delete({ userId, type: newType, normalizedName: newNormalized });
      await this.aliasRecords.delete({ userId, type: newType, normalizedName: newNormalized });

      // Every pre-correction identity resolves back to this entity so a later
      // extraction under the old name/type folds in rather than recreating.
      for (const [t, n] of [
        [oldType, oldNormalized],
        [newType, oldNormalized],
        [oldType, newNormalized],
      ] as [EntityType, string][]) {
        if (t === newType && n === newNormalized) continue; // the entity itself
        await this.recordAlias(userId, t, n, id, newNormalized, newType);
      }
      if (nameChanged) {
        const aliases = new Set(row.aliases ?? []);
        aliases.add(oldCanonical);
        row.aliases = [...aliases];
      }
    }

    row.type = newType;
    row.canonicalName = newCanonical;
    row.normalizedName = newNormalized;
    // A non-person entity never carries a voice-profile link.
    if (newType !== 'person') row.voiceProfileId = null;
    await this.entities.save(row);
    return id;
  }

  /** Re-link (or unlink, with null) a person entity to a voice-profile contact. */
  async relinkContact(
    userId: string,
    id: string,
    voiceProfileId: string | null,
  ): Promise<string> {
    const row = await this.entities.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('entity not found');
    if (row.type !== 'person') {
      throw new BadRequestException('only person entities link to a voice-profile contact');
    }
    if (voiceProfileId !== null) {
      const profile = await this.profiles.findOne({ where: { id: voiceProfileId, userId } });
      if (!profile) throw new NotFoundException('voice profile not found');
    }
    row.voiceProfileId = voiceProfileId;
    await this.entities.save(row);
    return id;
  }

  /**
   * Delete/suppress an entity: record all of its normalized names (canonical +
   * aliases + any alias records pointing at it) as suppressions so extraction
   * never recreates it, clean its mentions/relations/alias rows, then delete
   * the row. Idempotent-ish: a missing entity throws NotFound.
   */
  async suppress(userId: string, id: string): Promise<void> {
    const row = await this.entities.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('entity not found');

    const names = new Set<string>([row.normalizedName]);
    for (const alias of row.aliases ?? []) {
      const normalized = normalize(alias);
      if (normalized) names.add(normalized);
    }
    // Names merged into this entity (alias records pointing at it) must be
    // suppressed too, or they resurrect as fresh entities after deletion.
    const aliasRows = await this.aliasRecords.find({ where: { entityId: id } });
    for (const aliasRow of aliasRows) names.add(aliasRow.normalizedName);

    for (const normalized of names) {
      await this.recordSuppression(userId, row.type, normalized);
    }

    // Clean derived data explicitly — don't depend on FK cascade being present
    // under sqlite's synchronize schema.
    await this.mentions.delete({ entityId: id });
    await this.relations.delete({ sourceEntityId: id });
    await this.relations.delete({ targetEntityId: id });
    await this.aliasRecords.delete({ entityId: id });
    await this.entities.delete({ id, userId });
  }

  /** Repoint the victim's mentions to the survivor, deduping on (extraction, entity). */
  private async repointMentions(victimId: string, survivorId: string): Promise<void> {
    const rows = await this.mentions.find({ where: { entityId: victimId } });
    for (const row of rows) {
      const clash = await this.mentions.findOne({
        where: { extractionId: row.extractionId, entityId: survivorId },
      });
      if (clash) {
        await this.mentions.delete({ id: row.id });
        continue;
      }
      row.entityId = survivorId;
      try {
        await this.mentions.save(row);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.mentions.delete({ id: row.id });
      }
    }
  }

  /**
   * Repoint the victim's relations to the survivor, dropping survivor→survivor
   * self-edges, re-canonicalizing symmetric edges, and deduping on the evidence
   * unique key (extraction, source, target, relationType).
   */
  private async repointRelations(victimId: string, survivorId: string): Promise<void> {
    const rows = await this.relations.find({
      where: [{ sourceEntityId: victimId }, { targetEntityId: victimId }],
    });
    for (const row of rows) {
      let source = row.sourceEntityId === victimId ? survivorId : row.sourceEntityId;
      let target = row.targetEntityId === victimId ? survivorId : row.targetEntityId;
      if (source === target) {
        await this.relations.delete({ id: row.id }); // self-edge after merge
        continue;
      }
      if (SYMMETRIC_RELATION_TYPES.has(row.relationType) && target < source) {
        [source, target] = [target, source];
      }
      const clash = await this.relations.findOne({
        where: {
          extractionId: row.extractionId,
          sourceEntityId: source,
          targetEntityId: target,
          relationType: row.relationType,
        },
      });
      if (clash && clash.id !== row.id) {
        await this.relations.delete({ id: row.id });
        continue;
      }
      row.sourceEntityId = source;
      row.targetEntityId = target;
      try {
        await this.relations.save(row);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.relations.delete({ id: row.id });
      }
    }
  }

  /**
   * Point a normalized name at a surviving entity. No-op when the name is empty
   * or equals the survivor's own canonical normalized name (the entity row
   * already covers it). Repoints an existing row; ignores unique-index races.
   */
  private async recordAlias(
    userId: string,
    type: EntityType,
    normalizedName: string,
    entityId: string,
    ownNormalized: string,
    ownType?: EntityType,
  ): Promise<void> {
    if (!normalizedName) return;
    if (normalizedName === ownNormalized && (ownType === undefined || ownType === type)) return;
    const existing = await this.aliasRecords.findOne({
      where: { userId, type, normalizedName },
    });
    if (existing) {
      if (existing.entityId !== entityId) {
        existing.entityId = entityId;
        await this.aliasRecords.save(existing);
      }
      return;
    }
    try {
      await this.aliasRecords.save(
        this.aliasRecords.create({ userId, type, normalizedName, entityId }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }

  /** Record a suppressed (type, normalizedName); idempotent, race-safe. */
  private async recordSuppression(
    userId: string,
    type: EntityType,
    normalizedName: string,
  ): Promise<void> {
    if (!normalizedName) return;
    const existing = await this.suppressions.findOne({
      where: { userId, type, normalizedName },
    });
    if (existing) return;
    try {
      await this.suppressions.save(
        this.suppressions.create({ userId, type, normalizedName }),
      );
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
}

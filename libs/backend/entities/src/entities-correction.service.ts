import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { type EntityType, type RelationType, sanitizeAliases } from '@plaudern/contracts';
import {
  CommitmentEntity,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  QuestionEntity,
  recomputePersonalFactSupersession,
  type PersonalFactGroupKey,
} from '@plaudern/persistence';
import { normalize } from './contact-matching';

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

/** The identity an alias must never shadow: the entity's own (type, name). */
interface OwnIdentity {
  type: EntityType;
  normalizedName: string;
}

/**
 * Manual entity corrections (JJ-63): merge two entities, rename/retype one,
 * and delete/suppress one (contact link/unlink/convert live in
 * EntitiesRegistryService, which owns the voiceProfileLinkOrigin model). The
 * hard part is DURABILITY — every correction writes to the `entity_aliases` /
 * `entity_suppressions` side tables the registry upsert path consults, so a
 * merge/rename/delete is not undone by the next extraction run or backfill.
 *
 * Every mutation runs in ONE database transaction: a crash mid-merge (mentions
 * repointed, alias not yet recorded, victim not yet deleted) must roll back
 * whole, or the very durability the side tables exist for is lost. Merge also
 * takes pessimistic row locks on both entities in deterministic id order (on
 * drivers that support them) so two opposite-direction merges serialize
 * instead of deleting both rows. Every step is user-scoped.
 */
@Injectable()
export class EntitiesCorrectionService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * Merge the victim into the survivor: union aliases (+ the person's voice
   * link), repoint every mention and relation to the survivor (deduping against
   * the unique constraints, dropping survivor→survivor self-edges), record the
   * victim's names as aliases of the survivor so re-extraction resolves to it,
   * then delete the victim. Returns the survivor id.
   *
   * The two entities may be of DIFFERENT types (the extractor sometimes tags the
   * same real-world thing as e.g. an organization in one recording and a product
   * in another). The SURVIVOR's type is kept; the victim's names are recorded as
   * aliases under both types so a later extraction under either type folds onto
   * the survivor. Person-only state (voice link, personal facts) is carried over
   * only when the survivor is a person.
   */
  async merge(userId: string, survivorId: string, victimId: string): Promise<string> {
    if (survivorId === victimId) {
      throw new BadRequestException('cannot merge an entity into itself');
    }
    return this.dataSource.transaction(async (manager) => {
      // Lock both rows in deterministic id order (no AB/BA deadlock) and
      // re-verify existence under the lock, so two concurrent opposite-direction
      // merges serialize — the second sees the first's delete and 404s instead
      // of both entities disappearing.
      const [firstId, secondId] = [survivorId, victimId].sort();
      const first = await this.lockEntity(manager, userId, firstId);
      const second = await this.lockEntity(manager, userId, secondId);
      const survivor = survivorId === firstId ? first : second;
      const victim = victimId === firstId ? first : second;
      if (!survivor || !victim) throw new NotFoundException('entity not found');

      await this.repointMentions(manager, victimId, survivorId);
      await this.repointRelations(manager, victimId, survivorId);
      // Personal facts (JJ-31) are person-scoped. Only carry them over when the
      // SURVIVOR is a person; merging a person into a non-person deliberately
      // discards the dossier rather than keying it to a non-person subject
      // (personEntityId has no FK, so the victim delete still succeeds).
      if (survivor.type === 'person') {
        await this.repointFacts(manager, userId, victimId, survivorId);
      }
      await this.repointQuestions(manager, victimId, survivorId);
      await this.repointCommitments(manager, victimId, survivorId);

      // Union the victim's known spellings onto the survivor. The user chose the
      // survivor, so its canonical name is kept; the victim's becomes an alias.
      const aliases = new Set(survivor.aliases ?? []);
      for (const alias of victim.aliases ?? []) aliases.add(alias);
      aliases.add(victim.canonicalName);
      survivor.aliases = sanitizeAliases(survivor.canonicalName, [...aliases]);
      // Contact link: an unlinked survivor adopts the victim's link WITH its
      // origin (manual stays manual, auto stays auto). When neither is linked
      // but either side was explicitly unlinked (`suppressed`), the merged
      // entity stays suppressed — sweeps must not redo what the user undid.
      // Only a person survivor may hold a voice link; a non-person survivor
      // keeps its null link and a person victim's link is dropped on merge.
      if (survivor.type === 'person') {
        if (!survivor.voiceProfileId && victim.voiceProfileId) {
          survivor.voiceProfileId = victim.voiceProfileId;
          survivor.voiceProfileLinkOrigin = victim.voiceProfileLinkOrigin;
        } else if (
          !survivor.voiceProfileId &&
          (survivor.voiceProfileLinkOrigin === 'suppressed' ||
            victim.voiceProfileLinkOrigin === 'suppressed')
        ) {
          survivor.voiceProfileLinkOrigin = 'suppressed';
        }
      }
      await manager.save(survivor);

      // Alias records so future extraction/backfill resolves the victim's names
      // to the survivor instead of recreating a duplicate. Existing alias rows
      // that pointed at the victim are repointed (their unique key is unchanged,
      // so no conflict is possible).
      const own: OwnIdentity = { type: survivor.type, normalizedName: survivor.normalizedName };
      const victimAliasRows = await manager.find(EntityAliasEntity, {
        where: { entityId: victimId },
      });
      for (const row of victimAliasRows) row.entityId = survivorId;
      if (victimAliasRows.length > 0) await manager.save(victimAliasRows);
      // Record the victim's names under BOTH the survivor's and the victim's
      // type. The survivor's type keeps future same-type extractions resolving
      // here; the victim's type covers the cross-type case, so a later
      // extraction that still emits the victim's ORIGINAL type folds onto the
      // survivor (via the registry's cross-type alias redirect) instead of
      // resurrecting the duplicate. `recordAlias` no-ops on the survivor's own
      // identity and dedupes, so the shared-type case records once.
      for (const type of new Set<EntityType>([survivor.type, victim.type])) {
        await this.recordAlias(manager, userId, type, victim.normalizedName, survivorId, own);
        for (const alias of victim.aliases ?? []) {
          await this.recordAlias(manager, userId, type, normalize(alias), survivorId, own);
        }
      }

      // The victim's mentions/relations/aliases are all repointed; drop it.
      await manager.delete(EntityRegistryEntity, { id: victimId, userId });
      return survivorId;
    });
  }

  /**
   * Correct a wrong extraction: rename and/or retype. The OLD identity (old
   * name, and on retype the old type) is preserved as an alias so re-extraction
   * folds back in instead of recreating the pre-correction row. On retype,
   * every alias pointing here (names merged in earlier) is additionally
   * registered under the NEW type, so those spellings keep resolving here no
   * matter which type the model assigns. Renaming to a previously suppressed
   * name un-suppresses it. Returns the entity id.
   */
  async update(
    userId: string,
    id: string,
    changes: { canonicalName?: string; type?: EntityType },
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const row = await this.lockEntity(manager, userId, id);
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
        const clash = await manager.findOne(EntityRegistryEntity, {
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
        await manager.delete(EntitySuppressionEntity, {
          userId,
          type: newType,
          normalizedName: newNormalized,
        });
        await manager.delete(EntityAliasEntity, {
          userId,
          type: newType,
          normalizedName: newNormalized,
        });

        // Every pre-correction identity resolves back to this entity so a later
        // extraction under the old name/type folds in rather than recreating.
        const own: OwnIdentity = { type: newType, normalizedName: newNormalized };
        for (const [t, n] of [
          [oldType, oldNormalized],
          [newType, oldNormalized],
          [oldType, newNormalized],
        ] as [EntityType, string][]) {
          await this.recordAlias(manager, userId, t, n, id, own);
        }
        if (nameChanged) {
          const aliases = new Set(row.aliases ?? []);
          aliases.add(oldCanonical);
          row.aliases = sanitizeAliases(newCanonical, [...aliases]);
        }
        if (typeChanged) {
          // Names merged into this entity earlier carry the old type on their
          // alias rows. Keep those (the model may keep emitting the old type)
          // and register new-type counterparts, without stealing a name that
          // already resolves elsewhere under the new type.
          const pointingHere = await manager.find(EntityAliasEntity, {
            where: { userId, entityId: id },
          });
          for (const aliasRow of pointingHere) {
            if (aliasRow.type === newType) continue;
            await this.recordAlias(
              manager,
              userId,
              newType,
              aliasRow.normalizedName,
              id,
              own,
              false,
            );
          }
        }
      }

      row.type = newType;
      row.canonicalName = newCanonical;
      row.normalizedName = newNormalized;
      // A non-person entity never carries a voice-profile link (or an origin).
      if (newType !== 'person') {
        row.voiceProfileId = null;
        row.voiceProfileLinkOrigin = null;
      }
      await manager.save(row);
      return id;
    });
  }

  /**
   * Delete/suppress an entity: record all of its normalized names (canonical +
   * aliases, plus any alias records pointing at it, each under the type its
   * alias row carries) as suppressions so extraction never recreates it, clean
   * its mentions/relations/alias rows, then delete the row.
   */
  async suppress(userId: string, id: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const row = await this.lockEntity(manager, userId, id);
      if (!row) throw new NotFoundException('entity not found');

      const names = new Map<string, { type: EntityType; normalizedName: string }>();
      const add = (type: EntityType, normalizedName: string) => {
        if (normalizedName) names.set(`${type}:${normalizedName}`, { type, normalizedName });
      };
      add(row.type, row.normalizedName);
      for (const alias of row.aliases ?? []) add(row.type, normalize(alias));
      // Names merged into this entity (alias records pointing at it) must be
      // suppressed too — under their own recorded type, which may differ after
      // a retype — or they resurrect as fresh entities after deletion.
      const aliasRows = await manager.find(EntityAliasEntity, { where: { entityId: id } });
      for (const aliasRow of aliasRows) add(aliasRow.type, aliasRow.normalizedName);

      for (const { type, normalizedName } of names.values()) {
        await this.recordSuppression(manager, userId, type, normalizedName);
      }

      // Clean derived data explicitly — don't depend on FK cascade being present
      // under sqlite's synchronize schema.
      await manager.delete(EntityMentionEntity, { entityId: id });
      await manager.delete(EntityRelationEntity, { sourceEntityId: id });
      await manager.delete(EntityRelationEntity, { targetEntityId: id });
      await manager.delete(EntityAliasEntity, { entityId: id });
      await manager.delete(EntityRegistryEntity, { id, userId });
    });
  }

  /**
   * Load one entity under a pessimistic write lock (SELECT … FOR UPDATE) where
   * the driver supports it. sqlite — the test driver — doesn't; its
   * transactions serialize writers anyway.
   */
  private lockEntity(
    manager: EntityManager,
    userId: string,
    id: string,
  ): Promise<EntityRegistryEntity | null> {
    const lock =
      this.dataSource.options.type === 'postgres'
        ? { lock: { mode: 'pessimistic_write' as const } }
        : {};
    return manager.findOne(EntityRegistryEntity, { where: { id, userId }, ...lock });
  }

  /**
   * Repoint the victim's mentions to the survivor, deduping on the
   * (extraction, entity) unique key. Runs inside the merge transaction, so the
   * pre-checks see this transaction's own writes.
   */
  private async repointMentions(
    manager: EntityManager,
    victimId: string,
    survivorId: string,
  ): Promise<void> {
    const rows = await manager.find(EntityMentionEntity, { where: { entityId: victimId } });
    for (const row of rows) {
      const clash = await manager.findOne(EntityMentionEntity, {
        where: { extractionId: row.extractionId, entityId: survivorId },
      });
      if (clash) {
        await manager.delete(EntityMentionEntity, { id: row.id });
        continue;
      }
      row.entityId = survivorId;
      await manager.save(row);
    }
  }

  /**
   * Repoint the victim's relations to the survivor, dropping survivor→survivor
   * self-edges, re-canonicalizing symmetric edges, and deduping on the evidence
   * unique key (extraction, source, target, relationType).
   */
  private async repointRelations(
    manager: EntityManager,
    victimId: string,
    survivorId: string,
  ): Promise<void> {
    const rows = await manager.find(EntityRelationEntity, {
      where: [{ sourceEntityId: victimId }, { targetEntityId: victimId }],
    });
    for (const row of rows) {
      let source = row.sourceEntityId === victimId ? survivorId : row.sourceEntityId;
      let target = row.targetEntityId === victimId ? survivorId : row.targetEntityId;
      if (source === target) {
        await manager.delete(EntityRelationEntity, { id: row.id }); // self-edge after merge
        continue;
      }
      if (SYMMETRIC_RELATION_TYPES.has(row.relationType) && target < source) {
        [source, target] = [target, source];
      }
      const clash = await manager.findOne(EntityRelationEntity, {
        where: {
          extractionId: row.extractionId,
          sourceEntityId: source,
          targetEntityId: target,
          relationType: row.relationType,
        },
      });
      if (clash && clash.id !== row.id) {
        await manager.delete(EntityRelationEntity, { id: row.id });
        continue;
      }
      row.sourceEntityId = source;
      row.targetEntityId = target;
      await manager.save(row);
    }
  }

  /**
   * Repoint the victim's personal facts (JJ-31) to the survivor so a merge never
   * strands a person's dossier: each fact linked to the victim adopts the
   * survivor's `personEntityId` + `subjectKey`. On a clash with an identical
   * survivor fact (same attribute+value), the victim fact's citations are moved
   * onto the survivor fact (deduping on the (extraction, fact) unique key) and
   * the victim fact is dropped; any survivor this victim fact had superseded is
   * un-pointed first so the append-only supersede graph never dangles. The
   * merged (subject, attribute) groups are then RECOMPUTED — inside this same
   * merge transaction — so two previously-active exclusive facts (one per
   * pre-merge entity) collapse to exactly one active fact. Facts recorded under
   * a raw name before the entity existed are not repointed here — they fold in
   * on the next extraction, exactly as relations/mentions do.
   */
  private async repointFacts(
    manager: EntityManager,
    userId: string,
    victimId: string,
    survivorId: string,
  ): Promise<void> {
    const facts = manager.getRepository(PersonalFactEntity);
    const citations = manager.getRepository(PersonalFactCitationEntity);
    const survivorKey = `e:${survivorId}`;
    const rows = await facts.find({ where: { userId, personEntityId: victimId } });
    const touchedGroups = new Map<string, PersonalFactGroupKey>();
    for (const row of rows) {
      touchedGroups.set(row.normalizedAttribute, {
        userId,
        subjectKey: survivorKey,
        normalizedAttribute: row.normalizedAttribute,
      });
      const clash = await facts.findOne({
        where: {
          userId,
          subjectKey: survivorKey,
          normalizedAttribute: row.normalizedAttribute,
          normalizedValue: row.normalizedValue,
        },
      });
      if (clash && clash.id !== row.id) {
        const rowCitations = await citations.find({ where: { factId: row.id } });
        for (const citation of rowCitations) {
          const exists = await citations.findOne({
            where: { extractionId: citation.extractionId, factId: clash.id },
          });
          if (exists) {
            await citations.delete({ id: citation.id });
            continue;
          }
          citation.factId = clash.id;
          await citations.save(citation);
        }
        await facts.update(
          { supersededByFactId: row.id },
          { supersededByFactId: null, supersededAt: null },
        );
        await facts.delete({ id: row.id });
        continue;
      }
      row.personEntityId = survivorId;
      row.subjectKey = survivorKey;
      await facts.save(row);
    }
    // Restore the supersession invariant for every group the merge disturbed,
    // atomically with the merge itself.
    await recomputePersonalFactSupersession(manager, [...touchedGroups.values()]);
  }

  /**
   * Repoint the victim's `questions.counterpartyEntityId` (JJ-34) to the
   * survivor, so a merge never strands an open/asked question's counterparty
   * link. This is a loose (no-FK) reference and isn't part of the row's unique
   * key (inboxItemId, direction, normalizedQuestion), so — unlike mentions and
   * relations — no dedup/clash handling is needed: a plain bulk update
   * suffices.
   */
  private async repointQuestions(
    manager: EntityManager,
    victimId: string,
    survivorId: string,
  ): Promise<void> {
    await manager.update(
      QuestionEntity,
      { counterpartyEntityId: victimId },
      { counterpartyEntityId: survivorId },
    );
  }

  /**
   * Repoint the victim's `commitments.counterpartyEntityId` (JJ-36) to the
   * survivor, mirroring {@link repointQuestions}: the counterparty link is a
   * loose reference outside the row's unique key (inboxItemId, direction,
   * normalizedDescription), so a plain bulk update is safe.
   */
  private async repointCommitments(
    manager: EntityManager,
    victimId: string,
    survivorId: string,
  ): Promise<void> {
    await manager.update(
      CommitmentEntity,
      { counterpartyEntityId: victimId },
      { counterpartyEntityId: survivorId },
    );
  }

  /**
   * Point a normalized name at a surviving entity. No-op when the name is
   * empty or equals the survivor's own current identity (the entity row
   * already covers it). With `overwrite` (the default) an existing row is
   * repointed; without it a name already resolving elsewhere is left alone.
   */
  private async recordAlias(
    manager: EntityManager,
    userId: string,
    type: EntityType,
    normalizedName: string,
    entityId: string,
    own: OwnIdentity,
    overwrite = true,
  ): Promise<void> {
    if (!normalizedName) return;
    if (type === own.type && normalizedName === own.normalizedName) return;
    const existing = await manager.findOne(EntityAliasEntity, {
      where: { userId, type, normalizedName },
    });
    if (existing) {
      if (overwrite && existing.entityId !== entityId) {
        existing.entityId = entityId;
        await manager.save(existing);
      }
      return;
    }
    await manager.save(
      manager.create(EntityAliasEntity, { userId, type, normalizedName, entityId }),
    );
  }

  /** Record a suppressed (type, normalizedName); idempotent. */
  private async recordSuppression(
    manager: EntityManager,
    userId: string,
    type: EntityType,
    normalizedName: string,
  ): Promise<void> {
    if (!normalizedName) return;
    const existing = await manager.findOne(EntitySuppressionEntity, {
      where: { userId, type, normalizedName },
    });
    if (existing) return;
    await manager.save(manager.create(EntitySuppressionEntity, { userId, type, normalizedName }));
  }
}

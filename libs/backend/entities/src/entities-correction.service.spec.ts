import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type { ExtractedEntity } from '@plaudern/contracts';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntitiesCorrectionService } from './entities-correction.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

/**
 * The corrections must be DURABLE against re-extraction: a merge/rename/delete
 * is only correct if the next extraction that sees the pre-correction name
 * folds back onto the surviving entity (or stays gone) instead of resurrecting
 * a duplicate. These tests drive the real registry ingest path after each
 * correction to prove that.
 */
describe('EntitiesCorrectionService', () => {
  let dataSource: DataSource;
  let registry: EntitiesRegistryService;
  let corrections: EntitiesCorrectionService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    registry = new EntitiesRegistryService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(VoiceProfileEntity),
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
    corrections = new EntitiesCorrectionService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(EntityRelationEntity),
      dataSource.getRepository(VoiceProfileEntity),
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createItem(occurredAt = '2026-07-01T10:00:00Z'): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  async function createEntitiesExtraction(inboxItemId: string, createdAt: Date): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'entities',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt,
    });
    return row.id;
  }

  async function ingest(
    item: string,
    ext: string,
    extracted: ExtractedEntity[],
  ): Promise<void> {
    await registry.ingest(USER, item, ext, extracted);
  }

  /** Find the (single) live registry row of a type by canonical name. */
  async function entityByName(name: string): Promise<EntityRegistryEntity | null> {
    return dataSource
      .getRepository(EntityRegistryEntity)
      .findOne({ where: { userId: USER, canonicalName: name } });
  }

  it('merges: unions aliases, repoints the victim mention, deletes the victim', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: ['Detlef Müller'] },
      { type: 'person', name: 'Detlef', mentions: ['Detlef'] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;

    const survivorId = await corrections.merge(USER, survivor.id, victim.id);
    expect(survivorId).toBe(survivor.id);

    // Victim is gone; survivor absorbed its aliases.
    expect(await entityByName('Detlef')).toBeNull();
    const merged = (await entityByName('Detlef Müller'))!;
    expect(merged.aliases.sort()).toEqual(['Detlef', 'Detlef Müller'].sort());

    // The victim's mention now points at the survivor (no duplicate).
    const detail = await registry.detail(USER, survivorId);
    expect(detail.mentionCount).toBe(1);
    expect(await dataSource.getRepository(EntityMentionEntity).count()).toBe(1);
  });

  it('merge is durable: re-extraction of the victim name resolves to the survivor', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;
    await corrections.merge(USER, survivor.id, victim.id);

    // A later recording mentions only "Detlef" — must NOT resurrect a duplicate.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [{ type: 'person', name: 'Detlef', mentions: ['Detlef'] }]);

    expect(await entityByName('Detlef')).toBeNull();
    const list = await registry.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(survivor.id);
    expect(list[0].mentionCount).toBe(2);
  });

  it('merge repoints relations, deduping and dropping self-edges', async () => {
    const relations = dataSource.getRepository(EntityRelationEntity);
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
      { type: 'organization', name: 'ACME', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;
    const acme = (await entityByName('ACME'))!;

    // Survivor—ACME (works_at) and victim—ACME (works_at): after merge these
    // collide on the evidence unique key and must dedupe, not crash.
    await relations.save({ userId: USER, inboxItemId: item, extractionId: ext, sourceEntityId: survivor.id, targetEntityId: acme.id, relationType: 'works_at', label: null, confidence: null, origin: 'llm' });
    await relations.save({ userId: USER, inboxItemId: item, extractionId: ext, sourceEntityId: victim.id, targetEntityId: acme.id, relationType: 'works_at', label: null, confidence: null, origin: 'llm' });
    // Victim—survivor edge becomes a survivor→survivor self-edge → dropped.
    await relations.save({ userId: USER, inboxItemId: item, extractionId: ext, sourceEntityId: victim.id, targetEntityId: survivor.id, relationType: 'related_to', label: null, confidence: null, origin: 'llm' });

    await corrections.merge(USER, survivor.id, victim.id);

    const rows = await relations.find();
    // One works_at (deduped) survivor→ACME, zero self-edges.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceEntityId: survivor.id, targetEntityId: acme.id, relationType: 'works_at' });
  });

  it('rejects merging different types and self-merge', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Bob', mentions: [] },
      { type: 'organization', name: 'Bobco', mentions: [] },
    ]);
    const person = (await entityByName('Bob'))!;
    const org = (await entityByName('Bobco'))!;

    await expect(corrections.merge(USER, person.id, org.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(corrections.merge(USER, person.id, person.id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rename keeps the old name as a durable alias', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Bob', mentions: [] }]);
    const bob = (await entityByName('Bob'))!;

    await corrections.update(USER, bob.id, { canonicalName: 'Robert Smith' });
    const renamed = (await entityByName('Robert Smith'))!;
    expect(renamed.aliases).toContain('Bob');

    // Re-extraction under the OLD name folds back in, no resurrection.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [{ type: 'person', name: 'Bob', mentions: [] }]);

    expect(await entityByName('Bob')).toBeNull();
    const list = await registry.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(bob.id);
  });

  it('retype is durable: re-extraction under the old type folds in', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Aspirin', mentions: [] }]);
    const wrong = (await entityByName('Aspirin'))!;

    await corrections.update(USER, wrong.id, { type: 'medication' });
    const fixed = (await entityByName('Aspirin'))!;
    expect(fixed.type).toBe('medication');

    // The model still calls it a person next time — must fold into the fixed row.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [{ type: 'person', name: 'Aspirin', mentions: [] }]);

    const list = await registry.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(fixed.id);
    expect(list[0].type).toBe('medication');
  });

  it('rejects renaming onto an existing entity (merge instead)', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Bob', mentions: [] },
      { type: 'person', name: 'Robert', mentions: [] },
    ]);
    const bob = (await entityByName('Bob'))!;

    await expect(
      corrections.update(USER, bob.id, { canonicalName: 'Robert' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('suppress: deleted entity is not recreated by re-extraction', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Ghost', mentions: ['Ghosty'] },
      { type: 'person', name: 'Keep', mentions: [] },
    ]);
    const ghost = (await entityByName('Ghost'))!;

    await corrections.suppress(USER, ghost.id);
    expect(await entityByName('Ghost')).toBeNull();

    // Re-extraction of the suppressed name (and its alias) recreates nothing.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [
      { type: 'person', name: 'Ghost', mentions: [] },
      { type: 'person', name: 'Ghosty', mentions: [] },
    ]);

    expect(await entityByName('Ghost')).toBeNull();
    expect(await entityByName('Ghosty')).toBeNull();
    expect((await registry.list(USER, undefined, true)).map((e) => e.canonicalName)).toEqual(['Keep']);
  });

  it('re-links and unlinks a person entity to a voice profile', async () => {
    const profile = await dataSource
      .getRepository(VoiceProfileEntity)
      .save({ userId: USER, name: 'Someone', status: 'confirmed' });
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Bob', mentions: [] }]);
    const bob = (await entityByName('Bob'))!;

    await corrections.relinkContact(USER, bob.id, profile.id);
    expect((await entityByName('Bob'))!.voiceProfileId).toBe(profile.id);

    await corrections.relinkContact(USER, bob.id, null);
    expect((await entityByName('Bob'))!.voiceProfileId).toBeNull();
  });

  it('rejects linking a non-person entity, and an unknown/foreign profile', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'organization', name: 'ACME', mentions: [] },
      { type: 'person', name: 'Bob', mentions: [] },
    ]);
    const acme = (await entityByName('ACME'))!;
    const bob = (await entityByName('Bob'))!;
    const foreign = await dataSource
      .getRepository(VoiceProfileEntity)
      .save({ userId: OTHER_USER, name: 'Nope', status: 'confirmed' });

    await expect(corrections.relinkContact(USER, acme.id, null)).rejects.toBeInstanceOf(BadRequestException);
    await expect(corrections.relinkContact(USER, bob.id, foreign.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('scopes every correction to the owning user', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Bob', mentions: [] }]);
    const bob = (await entityByName('Bob'))!;

    await expect(corrections.suppress(OTHER_USER, bob.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      corrections.update(OTHER_USER, bob.id, { canonicalName: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

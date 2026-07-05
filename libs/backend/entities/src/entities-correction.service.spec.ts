import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  CommitmentEntity,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  QuestionEntity,
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
    corrections = new EntitiesCorrectionService(dataSource);
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
    // The victim's canonical becomes an alias; the survivor's own canonical is
    // redundant with the header and is not duplicated into the alias list.
    expect(merged.aliases.sort()).toEqual(['Detlef'].sort());

    // The victim's mention now points at the survivor (no duplicate).
    const detail = await registry.detail(USER, survivorId);
    expect(detail.mentionCount).toBe(1);
    expect(await dataSource.getRepository(EntityMentionEntity).count()).toBe(1);
  });

  it('merge repoints personal facts and recomputes supersession to a SINGLE active (JJ-31)', async () => {
    // Two person entities, each with one EXCLUSIVE "current city" fact backed by
    // a live facts citation — both active in their own (pre-merge) groups.
    const survivor = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName: 'Anna',
      normalizedName: 'anna',
      aliases: [],
    });
    const victim = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName: 'Ana',
      normalizedName: 'ana',
      aliases: [],
    });
    const facts = dataSource.getRepository(PersonalFactEntity);
    const factCitations = dataSource.getRepository(PersonalFactCitationEntity);

    async function seedFact(
      entityId: string,
      value: string,
      occurredAt: string,
    ): Promise<string> {
      const item = await createItem(occurredAt);
      const ext = await dataSource.getRepository(ExtractedPayloadEntity).save({
        inboxItemId: item,
        kind: 'facts',
        version: 1,
        provider: 'test',
        status: 'succeeded',
        createdAt: new Date(occurredAt),
      });
      const fact = await facts.save({
        userId: USER,
        personEntityId: entityId,
        personName: 'Anna',
        subjectKey: `e:${entityId}`,
        attribute: 'current city',
        normalizedAttribute: 'current city',
        value,
        normalizedValue: value.toLowerCase(),
        exclusive: true,
        supersededByFactId: null,
        supersededAt: null,
        lastOccurredAt: occurredAt,
      });
      await factCitations.save({
        userId: USER,
        factId: fact.id,
        inboxItemId: item,
        extractionId: ext.id,
        quote: null,
        startSeconds: null,
      });
      return fact.id;
    }

    const survivorFactId = await seedFact(survivor.id, 'Berlin', '2026-01-01T00:00:00.000Z');
    const victimFactId = await seedFact(victim.id, 'Munich', '2026-03-01T00:00:00.000Z');

    await corrections.merge(USER, survivor.id, victim.id);

    // Both facts now belong to the survivor's subject; the merge recompute
    // collapses the two once-active exclusive facts to exactly ONE active — the
    // newest (Munich) — with Berlin superseded by it. Nothing hard-deleted.
    const all = await facts.find({ where: { userId: USER } });
    expect(all).toHaveLength(2);
    expect(all.every((f) => f.subjectKey === `e:${survivor.id}`)).toBe(true);
    const active = all.filter((f) => f.supersededByFactId === null);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(victimFactId);
    expect(active[0].value).toBe('Munich');
    const superseded = all.find((f) => f.id === survivorFactId)!;
    expect(superseded.supersededByFactId).toBe(victimFactId);
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

  it('merge repoints question/commitment counterpartyEntityId (JJ-70)', async () => {
    const questions = dataSource.getRepository(QuestionEntity);
    const commitments = dataSource.getRepository(CommitmentEntity);
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;

    const questionsExt = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item,
      kind: 'questions',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });
    const commitmentsExt = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item,
      kind: 'commitments',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });

    const question = await questions.save({
      userId: USER,
      inboxItemId: item,
      extractionId: questionsExt.id,
      direction: 'asked_of_me',
      counterpartyName: 'Detlef',
      counterpartyEntityId: victim.id,
      question: 'When can you send the report?',
      normalizedQuestion: 'when can you send the report?',
      status: 'open',
      sourceTimestamp: null,
      sourceQuote: null,
    });
    const commitment = await commitments.save({
      userId: USER,
      inboxItemId: item,
      extractionId: commitmentsExt.id,
      direction: 'owed_to_me',
      counterpartyName: 'Detlef',
      counterpartyEntityId: victim.id,
      description: 'send the report by Friday',
      normalizedDescription: 'send the report by friday',
      dueDate: null,
      status: 'open',
      duplicatesTaskId: null,
      sourceTimestamp: null,
      sourceQuote: null,
    });

    await corrections.merge(USER, survivor.id, victim.id);

    const mergedQuestion = await questions.findOneBy({ id: question.id });
    const mergedCommitment = await commitments.findOneBy({ id: commitment.id });
    expect(mergedQuestion!.counterpartyEntityId).toBe(survivor.id);
    expect(mergedCommitment!.counterpartyEntityId).toBe(survivor.id);
  });

  it('rejects self-merge', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Bob', mentions: [] }]);
    const person = (await entityByName('Bob'))!;

    await expect(corrections.merge(USER, person.id, person.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('merges across types: survivor keeps its type, victim name aliased under BOTH types', async () => {
    const entities = dataSource.getRepository(EntityRegistryEntity);
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    // Same name, split into two types by the extractor across recordings.
    await ingest(item, ext, [
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const org = (await entities.findOne({ where: { userId: USER, type: 'organization' } }))!;
    const product = (await entities.findOne({ where: { userId: USER, type: 'product' } }))!;

    // Merge the organization INTO the product — the real thing is the product.
    await corrections.merge(USER, product.id, org.id);

    // Survivor stays a product; the organization row is gone.
    const survivor = (await entities.findOne({ where: { id: product.id } }))!;
    expect(survivor.type).toBe('product');
    expect(await entities.findOne({ where: { id: org.id } })).toBeNull();

    // The victim's name is aliased under BOTH the survivor's and the victim's
    // type, so re-extraction under EITHER type folds onto the survivor.
    const aliasRepo = dataSource.getRepository(EntityAliasEntity);
    const orgAlias = await aliasRepo.findOne({
      where: { userId: USER, type: 'organization', normalizedName: 'foo' },
    });
    expect(orgAlias?.entityId).toBe(product.id);

    // A later recording still tagging "Foo" as an organization must NOT
    // resurrect the duplicate — it folds onto the surviving product.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [{ type: 'organization', name: 'Foo', mentions: ['Foo'] }]);

    const list = await registry.list(USER);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(product.id);
    expect(list[0].mentionCount).toBe(2);
  });

  it('cross-type merge into a non-person survivor drops the person victim voice link', async () => {
    const entities = dataSource.getRepository(EntityRegistryEntity);
    const voice = await dataSource.getRepository(VoiceProfileEntity).save({
      userId: USER,
      name: 'Foo the person',
      voiceprint: null,
    });
    const product = await entities.save({
      userId: USER,
      type: 'product',
      canonicalName: 'Foo',
      normalizedName: 'foo',
      aliases: [],
    });
    const person = await entities.save({
      userId: USER,
      type: 'person',
      canonicalName: 'Foo',
      normalizedName: 'foo',
      aliases: [],
      voiceProfileId: voice.id,
      voiceProfileLinkOrigin: 'manual',
    });

    await corrections.merge(USER, product.id, person.id);

    const survivor = (await entities.findOne({ where: { id: product.id } }))!;
    expect(survivor.type).toBe('product');
    // A non-person survivor must never carry a voice link.
    expect(survivor.voiceProfileId).toBeNull();
    expect(survivor.voiceProfileLinkOrigin).toBeNull();
    expect(await entities.findOne({ where: { id: person.id } })).toBeNull();
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

  // Contact link/unlink/convert moved to EntitiesRegistryService (JJ-63 +
  // #78's voiceProfileLinkOrigin model) and are covered by its spec.

  it('merge adopts the victim contact link with its origin', async () => {
    const profile = await dataSource
      .getRepository(VoiceProfileEntity)
      .save({ userId: USER, name: 'Detlef Contact', status: 'confirmed' });
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;
    await registry.linkContact(USER, victim.id, profile.id); // manual link on the victim

    await corrections.merge(USER, survivor.id, victim.id);
    const merged = (await entityByName('Detlef Müller'))!;
    expect(merged.voiceProfileId).toBe(profile.id);
    expect(merged.voiceProfileLinkOrigin).toBe('manual');
  });

  it('merge keeps a suppressed link-origin so sweeps do not re-link', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;
    await registry.unlinkContact(USER, victim.id); // user said: do not auto-link

    await corrections.merge(USER, survivor.id, victim.id);
    const merged = (await entityByName('Detlef Müller'))!;
    expect(merged.voiceProfileId).toBeNull();
    expect(merged.voiceProfileLinkOrigin).toBe('suppressed');
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

  it('merge is atomic: a mid-merge failure rolls the whole mutation back', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [{ type: 'person', name: 'Detlef Müller', mentions: [] }]);
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [{ type: 'person', name: 'Detlef', mentions: [] }]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;

    // Fail AFTER mentions/relations were repointed but BEFORE the alias is
    // recorded and the victim deleted — exactly the crash window that would
    // otherwise leave a ghost victim that resurrects on the next backfill.
    const spy = jest
      .spyOn(corrections as unknown as { recordAlias: () => Promise<void> }, 'recordAlias')
      .mockRejectedValue(new Error('boom'));
    await expect(corrections.merge(USER, survivor.id, victim.id)).rejects.toThrow('boom');
    spy.mockRestore();

    // Everything rolled back: victim intact, its mention still points at it,
    // no alias leaked, survivor untouched.
    expect(await entityByName('Detlef')).not.toBeNull();
    const victimMentions = await dataSource
      .getRepository(EntityMentionEntity)
      .find({ where: { entityId: victim.id } });
    expect(victimMentions).toHaveLength(1);
    expect(await dataSource.getRepository(EntityAliasEntity).count()).toBe(0);
    expect((await entityByName('Detlef Müller'))!.aliases).toEqual(survivor.aliases);

    // And the same merge succeeds once the failure is gone.
    await corrections.merge(USER, survivor.id, victim.id);
    expect(await entityByName('Detlef')).toBeNull();
    expect((await registry.list(USER))[0].mentionCount).toBe(2);
  });

  it('after retype-after-merge, a wrong-type extraction cannot mutate the entity', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await ingest(item, ext, [
      { type: 'person', name: 'Detlef Müller', mentions: [] },
      { type: 'person', name: 'Detlef', mentions: [] },
    ]);
    const survivor = (await entityByName('Detlef Müller'))!;
    const victim = (await entityByName('Detlef'))!;
    await corrections.merge(USER, survivor.id, victim.id);
    await corrections.update(USER, survivor.id, { type: 'organization' });

    // A voice profile matching the merged-away name: a wrong-type fold must
    // never link it onto the (now) organization.
    await dataSource
      .getRepository(VoiceProfileEntity)
      .save({ userId: USER, name: 'Detlef', status: 'confirmed' });

    // The model still emits person "Detlef", with a new surface form.
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await ingest(item2, ext2, [
      { type: 'person', name: 'Detlef', mentions: ['Detlef der Große'] },
    ]);

    // No resurrected person duplicate, and the organization was not mutated —
    // no alias accretion, no rename, no voice link — but the mention still
    // lands on it (durability without cross-type mutation).
    const all = await dataSource
      .getRepository(EntityRegistryEntity)
      .find({ where: { userId: USER } });
    expect(all).toHaveLength(1);
    const org = all[0];
    expect(org.id).toBe(survivor.id);
    expect(org.type).toBe('organization');
    expect(org.canonicalName).toBe('Detlef Müller');
    expect(org.aliases).not.toContain('Detlef der Große');
    expect(org.voiceProfileId).toBeNull();
    expect((await registry.detail(USER, org.id)).mentionCount).toBe(2);

    // An extraction under the corrected type folds in fully — the retype
    // registered new-type counterparts for the merged-in names.
    const item3 = await createItem('2026-07-03T10:00:00Z');
    const ext3 = await createEntitiesExtraction(item3, new Date('2026-07-03T10:00:00Z'));
    await ingest(item3, ext3, [{ type: 'organization', name: 'Detlef', mentions: [] }]);
    expect(
      await dataSource.getRepository(EntityRegistryEntity).count({ where: { userId: USER } }),
    ).toBe(1);
    expect((await registry.detail(USER, org.id)).mentionCount).toBe(3);
  });
});

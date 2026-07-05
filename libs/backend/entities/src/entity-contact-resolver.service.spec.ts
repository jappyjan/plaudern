import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntityRelationEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type {
  ContactResolutionInput,
  ContactResolutionProvider,
  ContactResolutionResult,
} from './contact-resolution.provider';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityContactResolverService } from './entity-contact-resolver.service';
import { EntityGraphService } from './entity-graph.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

/** Provider stub: disabled by default; tests flip it on with a canned verdict. */
class FakeResolutionProvider implements ContactResolutionProvider {
  readonly id = 'fake';
  enabled = false;
  decision: ContactResolutionResult['decision'] = {
    voiceProfileId: null,
    confidence: 0,
    reason: '',
  };
  inputs: ContactResolutionInput[] = [];

  async resolve(input: ContactResolutionInput): Promise<ContactResolutionResult> {
    this.inputs.push(input);
    return { decision: this.decision, model: 'fake' };
  }
}

describe('EntityContactResolverService', () => {
  let dataSource: DataSource;
  let registry: EntitiesRegistryService;
  let resolver: EntityContactResolverService;
  let provider: FakeResolutionProvider;

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
    );
    const graph = new EntityGraphService(
      dataSource.getRepository(EntityRelationEntity),
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
    );
    provider = new FakeResolutionProvider();
    resolver = new EntityContactResolverService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(SpeakerOccurrenceEntity),
      dataSource.getRepository(VoiceProfileEntity),
      registry,
      graph,
      provider,
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

  async function createExtraction(
    inboxItemId: string,
    kind: 'entities' | 'diarization' | 'relations',
    createdAt = new Date('2026-07-01T10:00:00Z'),
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt,
    });
    return row.id;
  }

  async function createProfile(name: string | null): Promise<string> {
    const row = await dataSource.getRepository(VoiceProfileEntity).save({
      userId: USER,
      name,
      status: 'confirmed',
    });
    return row.id;
  }

  /** Person entity with one mention in the given item. */
  async function createPersonEntity(
    name: string,
    inboxItemId: string,
    voiceProfileId: string | null = null,
  ): Promise<EntityRegistryEntity> {
    const entity = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName: name,
      normalizedName: name.toLowerCase(),
      aliases: [name],
      voiceProfileId,
      voiceProfileLinkOrigin: voiceProfileId ? 'manual' : null,
    });
    const extractionId = await createExtraction(inboxItemId, 'entities');
    await dataSource.getRepository(EntityMentionEntity).save({
      userId: USER,
      inboxItemId,
      extractionId,
      entityId: entity.id,
      surfaceForm: name,
    });
    return entity;
  }

  async function addSpeaker(inboxItemId: string, voiceProfileId: string): Promise<void> {
    const extractionId = await createExtraction(inboxItemId, 'diarization');
    await dataSource.getRepository(SpeakerOccurrenceEntity).save({
      inboxItemId,
      extractionId,
      voiceProfileId,
      label: 'SPEAKER_00',
      speakingSeconds: 10,
      similarity: null,
    });
  }

  it('auto-links a first name to the contact whose voice is in the recordings', async () => {
    const mueller = await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const items = await Promise.all([createItem(), createItem(), createItem()]);
    const entity = await createPersonEntity('Detlef', items[0]);
    for (const item of items.slice(1)) {
      const ext = await createExtraction(item, 'entities');
      await dataSource
        .getRepository(EntityMentionEntity)
        .save({ userId: USER, inboxItemId: item, extractionId: ext, entityId: entity.id, surfaceForm: 'Detlef' });
    }
    // Müller speaks in all three recordings mentioning "Detlef"; Schmidt in none.
    for (const item of items) await addSpeaker(item, mueller);

    expect(await resolver.autoLinkAll(USER)).toBe(1);
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneByOrFail({ id: entity.id });
    expect(row.voiceProfileId).toBe(mueller);
    expect(row.voiceProfileLinkOrigin).toBe('auto');
  });

  it('stays unlinked when two candidates are indistinguishable (no LLM)', async () => {
    await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const item = await createItem();
    const entity = await createPersonEntity('Detlef', item);

    expect(await resolver.autoLinkAll(USER)).toBe(0);
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneByOrFail({ id: entity.id });
    expect(row.voiceProfileId).toBeNull();
  });

  it('asks the enabled LLM provider to settle ambiguity and applies its verdict', async () => {
    const mueller = await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const item = await createItem();
    const entity = await createPersonEntity('Detlef', item);

    provider.enabled = true;
    provider.decision = { voiceProfileId: mueller, confidence: 0.9, reason: 'same person' };
    expect(await resolver.autoLinkAll(USER)).toBe(1);
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0].entity.name).toBe('Detlef');
    expect(provider.inputs[0].candidates.map((c) => c.name)).toEqual(
      expect.arrayContaining(['Detlef Müller', 'Detlef Schmidt']),
    );
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneByOrFail({ id: entity.id });
    expect(row.voiceProfileId).toBe(mueller);
  });

  it('ignores a low-confidence or null LLM verdict', async () => {
    const mueller = await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const item = await createItem();
    const entity = await createPersonEntity('Detlef', item);

    provider.enabled = true;
    provider.decision = { voiceProfileId: mueller, confidence: 0.4, reason: 'maybe' };
    expect(await resolver.autoLinkAll(USER)).toBe(0);
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneByOrFail({ id: entity.id });
    expect(row.voiceProfileId).toBeNull();
  });

  it('links an exact (folded) name in a sweep — the rename-a-contact flow', async () => {
    const item = await createItem();
    const entity = await createPersonEntity('Detlef Mueller', item);
    expect(await resolver.autoLinkAll(USER)).toBe(0); // no contacts yet

    const mueller = await createProfile('Detlef Müller');
    expect(await resolver.autoLinkAll(USER)).toBe(1);
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneByOrFail({ id: entity.id });
    expect(row.voiceProfileId).toBe(mueller);
    expect(row.voiceProfileLinkOrigin).toBe('auto');
    // A second sweep finds nothing new.
    expect(await resolver.autoLinkAll(USER)).toBe(0);
  });

  it('never touches suppressed entities', async () => {
    await createProfile('Detlef Müller');
    const item = await createItem();
    const entity = await createPersonEntity('Detlef Müller', item);
    entity.voiceProfileId = null;
    entity.voiceProfileLinkOrigin = 'suppressed';
    await dataSource.getRepository(EntityRegistryEntity).save(entity);

    expect(await resolver.autoLinkAll(USER)).toBe(0);
  });

  it('uses shared graph neighbors as identity evidence in suggestions', async () => {
    const mueller = await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const itemA = await createItem('2026-07-01T10:00:00Z');
    const itemB = await createItem('2026-07-02T10:00:00Z');

    // Contact Müller's own linked entity relates to ACME in recording A…
    const muellerEntity = await createPersonEntity('Detlef Müller', itemA, mueller);
    const acme = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'organization',
      canonicalName: 'ACME',
      normalizedName: 'acme',
      aliases: [],
      voiceProfileId: null,
      voiceProfileLinkOrigin: null,
    });
    const relExtA = await createExtraction(itemA, 'relations');
    await dataSource.getRepository(EntityRelationEntity).save({
      userId: USER,
      inboxItemId: itemA,
      extractionId: relExtA,
      sourceEntityId: muellerEntity.id,
      targetEntityId: acme.id,
      relationType: 'works_at',
      label: null,
      confidence: 0.9,
      origin: 'llm',
    });

    // …and the unlinked "Detlef" from recording B relates to ACME too.
    const detlef = await createPersonEntity('Detlef', itemB);
    const relExtB = await createExtraction(itemB, 'relations');
    await dataSource.getRepository(EntityRelationEntity).save({
      userId: USER,
      inboxItemId: itemB,
      extractionId: relExtB,
      sourceEntityId: detlef.id,
      targetEntityId: acme.id,
      relationType: 'works_at',
      label: null,
      confidence: 0.9,
      origin: 'llm',
    });

    const suggestions = await resolver.suggest(USER, detlef.id);
    expect(suggestions[0].voiceProfileId).toBe(mueller);
    expect(suggestions[0].reasons.join(' ')).toContain('ACME');
    // Schmidt has no graph overlap; if listed at all, it must rank below.
    const schmidt = suggestions.find((s) => s.name === 'Detlef Schmidt');
    if (schmidt) expect(schmidt.confidence).toBeLessThan(suggestions[0].confidence);
  });

  it('counts co-mentions against a candidate — named together means different people', async () => {
    const anna = await createProfile('Anna');
    const item = await createItem();
    // The contact's own entity and the unlinked "Anna Schmidt" are mentioned
    // in the SAME recording — the co-occurrence edge is counter-evidence.
    const annaEntity = await createPersonEntity('Anna', item, anna);
    const other = await createPersonEntity('Anna Schmidt', item);
    const relExt = await createExtraction(item, 'relations');
    await dataSource.getRepository(EntityRelationEntity).save({
      userId: USER,
      inboxItemId: item,
      extractionId: relExt,
      sourceEntityId: annaEntity.id < other.id ? annaEntity.id : other.id,
      targetEntityId: annaEntity.id < other.id ? other.id : annaEntity.id,
      relationType: 'related_to',
      label: null,
      confidence: 0.2,
      origin: 'cooccurrence',
    });

    const suggestions = await resolver.suggest(USER, other.id);
    const candidate = suggestions.find((s) => s.voiceProfileId === anna);
    // Name affinity alone would suggest Anna; the co-mention must drag it down
    // below the decisive threshold (and its reasons must say why).
    expect(await resolver.autoLinkAll(USER)).toBe(0);
    if (candidate) {
      expect(candidate.reasons.join(' ')).toContain('different people');
    }
  });

  it('returns an empty suggestion list for non-person entities', async () => {
    const item = await createItem();
    const org = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'organization',
      canonicalName: 'ACME',
      normalizedName: 'acme',
      aliases: [],
      voiceProfileId: null,
      voiceProfileLinkOrigin: null,
    });
    void item;
    expect(await resolver.suggest(USER, org.id)).toEqual([]);
  });

  it('autoLinkAllUsers sweeps every user with unlinked people (the startup pass)', async () => {
    const OTHER = '00000000-0000-0000-0000-0000000000bb';
    const mueller = await createProfile('Detlef Müller');
    const item = await createItem();
    await createPersonEntity('Detlef Mueller', item); // exact-modulo-folding → links
    // A second user's data must be swept independently and never cross-link.
    const otherItem = await dataSource.getRepository(InboxItemEntity).save({
      userId: OTHER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const otherEntity = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: OTHER,
      type: 'person',
      canonicalName: 'Detlef Müller',
      normalizedName: 'detlef müller',
      aliases: [],
      voiceProfileId: null,
      voiceProfileLinkOrigin: null,
    });
    void otherItem;

    expect(await resolver.autoLinkAllUsers()).toBe(1);
    const rows = dataSource.getRepository(EntityRegistryEntity);
    // USER's entity linked; OTHER's stayed unlinked (Müller isn't their contact).
    expect((await rows.findOneByOrFail({ userId: USER, type: 'person' })).voiceProfileId).toBe(
      mueller,
    );
    expect((await rows.findOneByOrFail({ id: otherEntity.id })).voiceProfileId).toBeNull();
  });

  it('autoLinkForItem only touches entities mentioned by that item', async () => {
    const mueller = await createProfile('Detlef Müller');
    const itemA = await createItem();
    const itemB = await createItem();
    const inItem = await createPersonEntity('Detlef', itemA);
    const elsewhere = await createPersonEntity('Detlef Senior', itemB);
    await addSpeaker(itemA, mueller);
    await addSpeaker(itemB, mueller);

    await resolver.autoLinkForItem(USER, itemA);
    const rows = dataSource.getRepository(EntityRegistryEntity);
    expect((await rows.findOneByOrFail({ id: inItem.id })).voiceProfileId).toBe(mueller);
    expect((await rows.findOneByOrFail({ id: elsewhere.id })).voiceProfileId).toBeNull();
  });
});

import { DataSource, Repository } from 'typeorm';
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
import { FactsRegistryService } from '@plaudern/facts';
import { SelfProfileService } from '@plaudern/inbox';
import { CommitmentsService } from '@plaudern/commitments';
import { QuestionsService } from '@plaudern/questions';
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityGraphService } from './entity-graph.service';
import { DossierService } from './dossier.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * Exercises the person dossier aggregation against a real in-memory sqlite DB:
 * facts split into active + superseded (with per-fact source citations),
 * commitments in both directions, open questions, recent mentioning items with
 * resolved titles, and graceful tolerance of a dangling counterpartyEntityId
 * (a reference a merge left pointing at a now-missing entity). Mirrors the
 * facts/tasks registry spec strategy: synchronize + hand-wired services, no Nest.
 */
describe('DossierService', () => {
  let dataSource: DataSource;
  let service: DossierService;
  let items: Repository<InboxItemEntity>;
  let extractions: Repository<ExtractedPayloadEntity>;
  let entities: Repository<EntityRegistryEntity>;
  let mentions: Repository<EntityMentionEntity>;
  let relations: Repository<EntityRelationEntity>;
  let commitments: Repository<CommitmentEntity>;
  let questions: Repository<QuestionEntity>;
  let facts: Repository<PersonalFactEntity>;
  let citations: Repository<PersonalFactCitationEntity>;
  let factsRegistry: FactsRegistryService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    items = dataSource.getRepository(InboxItemEntity);
    extractions = dataSource.getRepository(ExtractedPayloadEntity);
    entities = dataSource.getRepository(EntityRegistryEntity);
    mentions = dataSource.getRepository(EntityMentionEntity);
    relations = dataSource.getRepository(EntityRelationEntity);
    commitments = dataSource.getRepository(CommitmentEntity);
    questions = dataSource.getRepository(QuestionEntity);
    facts = dataSource.getRepository(PersonalFactEntity);
    citations = dataSource.getRepository(PersonalFactCitationEntity);
    // The dossier's viewer is the account owner; give them a self profile so the
    // owner-gated commitments list is not empty.
    const voiceProfiles = dataSource.getRepository(VoiceProfileEntity);
    await voiceProfiles.save({ userId: USER, name: null, isSelf: true });
    const selfProfile = new SelfProfileService(voiceProfiles);

    const registry = new EntitiesRegistryService(
      entities,
      mentions,
      extractions,
      dataSource.getRepository(VoiceProfileEntity),
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
    const graph = new EntityGraphService(relations, entities, extractions);
    factsRegistry = new FactsRegistryService(facts, citations, extractions, entities);
    // list() on these services only touches their row + items repos, so the
    // pipeline collaborators (inbox/provider/queue) are unused here.
    const commitmentsService = new CommitmentsService(
      undefined as never,
      undefined as never,
      undefined as never,
      commitments,
      items,
      selfProfile,
    );
    const questionsService = new QuestionsService(
      undefined as never,
      undefined as never,
      undefined as never,
      questions,
      items,
    );
    service = new DossierService(
      registry,
      graph,
      factsRegistry,
      commitmentsService,
      questionsService,
      items,
      extractions,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function seedItem(occurredAt: string): Promise<string> {
    const item = await items.save(
      items.create({
        userId: USER,
        deviceId: null,
        sourceType: 'plaud' as never,
        occurredAt,
        idempotencyKey: `k-${occurredAt}-${Math.random()}`,
        metadata: null,
      }),
    );
    return item.id;
  }

  async function addExtraction(
    itemId: string,
    kind: ExtractedPayloadEntity['kind'],
    createdAt: Date,
    content?: string,
  ): Promise<string> {
    const row = await extractions.save(
      extractions.create({
        inboxItemId: itemId,
        kind,
        version: 1,
        provider: `test:${kind}`,
        status: 'succeeded',
        content: content ?? null,
      }),
    );
    await extractions.update({ id: row.id }, { createdAt });
    return row.id;
  }

  async function person(name: string): Promise<string> {
    const row = await entities.save(
      entities.create({
        userId: USER,
        type: 'person',
        canonicalName: name,
        normalizedName: name.trim().toLowerCase(),
        aliases: [],
        voiceProfileId: null,
        voiceProfileLinkOrigin: null,
      }),
    );
    return row.id;
  }

  async function mention(itemId: string, extractionId: string, entityId: string, surfaceForm: string) {
    await mentions.save(
      mentions.create({ userId: USER, inboxItemId: itemId, extractionId, entityId, surfaceForm }),
    );
  }

  const summary = (title: string) =>
    JSON.stringify({ title, layout: 'conversation', markdown: 'body' });

  it('aggregates facts, commitments, questions, relations and recent items with citations', async () => {
    const mia = await person('Mia');
    const other = await person('Tom');

    // Two recordings: an older one, a newer one.
    const item1 = await seedItem('2026-01-01T00:00:00.000Z');
    const item2 = await seedItem('2026-02-01T00:00:00.000Z');

    // Summary titles for citation/recent-item rendering.
    await addExtraction(item1, 'summary', new Date('2026-01-01T01:00:00Z'), summary('New Year call'));
    await addExtraction(item2, 'summary', new Date('2026-02-01T01:00:00Z'), summary('Coffee with Mia'));

    // Facts: an exclusive attribute (city) superseded across the two recordings,
    // plus an accumulative fact on the newer one.
    const facts1 = await addExtraction(item1, 'facts', new Date('2026-01-01T02:00:00Z'));
    const facts2 = await addExtraction(item2, 'facts', new Date('2026-02-01T02:00:00Z'));
    await factsRegistry.ingest(USER, item1, facts1, '2026-01-01T00:00:00.000Z', [
      { person: 'Mia', attribute: 'city', value: 'Berlin', exclusive: true, quote: 'lives in Berlin', startSeconds: 12 },
    ]);
    await factsRegistry.ingest(USER, item2, facts2, '2026-02-01T00:00:00.000Z', [
      { person: 'Mia', attribute: 'city', value: 'Munich', exclusive: true, quote: 'moved to Munich', startSeconds: 34 },
      { person: 'Mia', attribute: 'allergy', value: 'nuts', exclusive: false, quote: null, startSeconds: null },
    ]);

    // Mentions (need the item's latest succeeded `entities` extraction).
    const ent1 = await addExtraction(item1, 'entities', new Date('2026-01-01T02:30:00Z'));
    const ent2 = await addExtraction(item2, 'entities', new Date('2026-02-01T02:30:00Z'));
    await mention(item1, ent1, mia, 'Mia');
    await mention(item2, ent2, mia, 'Mia');
    await mention(item2, ent2, other, 'Tom');

    // A relation edge Mia—Tom (need a succeeded `relations` extraction).
    const rel2 = await addExtraction(item2, 'relations', new Date('2026-02-01T02:40:00Z'));
    await relations.save(
      relations.create({
        userId: USER,
        inboxItemId: item2,
        extractionId: rel2,
        sourceEntityId: mia,
        targetEntityId: other,
        relationType: 'discussed_with',
        label: 'the trip',
        confidence: 0.9,
        origin: 'llm',
      }),
    );

    // Commitments both directions for Mia.
    await commitments.save(
      commitments.create({
        userId: USER,
        inboxItemId: item2,
        extractionId: facts2,
        direction: 'owed_by_me',
        counterpartyName: 'Mia',
        counterpartyEntityId: mia,
        description: 'send the photos',
        normalizedDescription: 'send the photos',
        status: 'open',
        sourceTimestamp: 50,
        sourceQuote: null,
        dueDate: null,
      }),
    );
    await commitments.save(
      commitments.create({
        userId: USER,
        inboxItemId: item1,
        extractionId: facts1,
        direction: 'owed_to_me',
        counterpartyName: 'Mia',
        counterpartyEntityId: mia,
        description: 'return the book',
        normalizedDescription: 'return the book',
        status: 'open',
        sourceTimestamp: null,
        sourceQuote: null,
        dueDate: null,
      }),
    );

    // Open + answered questions for Mia (only the open one is surfaced).
    await questions.save(
      questions.create({
        userId: USER,
        inboxItemId: item2,
        extractionId: facts2,
        direction: 'asked_by_me',
        counterpartyName: 'Mia',
        counterpartyEntityId: mia,
        question: 'did she book the flight?',
        normalizedQuestion: 'did she book the flight?',
        status: 'open',
        sourceTimestamp: 60,
        sourceQuote: null,
      }),
    );
    await questions.save(
      questions.create({
        userId: USER,
        inboxItemId: item2,
        extractionId: facts2,
        direction: 'asked_of_me',
        counterpartyName: 'Mia',
        counterpartyEntityId: mia,
        question: 'what time is dinner?',
        normalizedQuestion: 'what time is dinner?',
        status: 'answered',
        sourceTimestamp: null,
        sourceQuote: null,
      }),
    );

    const dossier = await service.build(USER, mia);

    // Facts: Munich active, Berlin superseded; each cited to its recording.
    expect(dossier.facts.active.map((f) => f.value).sort()).toEqual(['Munich', 'nuts']);
    expect(dossier.facts.superseded.map((f) => f.value)).toEqual(['Berlin']);
    const munich = dossier.facts.active.find((f) => f.value === 'Munich')!;
    expect(munich.citations).toHaveLength(1);
    expect(munich.citations[0]).toMatchObject({
      inboxItemId: item2,
      title: 'Coffee with Mia',
      startSeconds: 34,
      quote: 'moved to Munich',
    });
    expect(dossier.facts.superseded[0].citations[0]).toMatchObject({
      inboxItemId: item1,
      title: 'New Year call',
    });

    // Commitments both ways, questions filtered to open.
    expect(dossier.commitments.owedByMe.map((c) => c.description)).toEqual(['send the photos']);
    expect(dossier.commitments.owedByMe[0].citation).toMatchObject({ inboxItemId: item2, startSeconds: 50 });
    expect(dossier.commitments.owedToMe.map((c) => c.description)).toEqual(['return the book']);
    expect(dossier.openQuestions.map((q) => q.question)).toEqual(['did she book the flight?']);

    // Relations + neighbor resolution.
    expect(dossier.relations).toHaveLength(1);
    expect(dossier.relations[0].relationType).toBe('discussed_with');
    expect(dossier.neighbors.map((n) => n.canonicalName)).toEqual(['Tom']);

    // Recent items newest first, with resolved titles.
    expect(dossier.recentItems.map((r) => r.inboxItemId)).toEqual([item2, item1]);
    expect(dossier.recentItems[0].title).toBe('Coffee with Mia');

    // Counts reflect the aggregation.
    expect(dossier.counts).toMatchObject({
      activeFacts: 2,
      supersededFacts: 1,
      owedByMe: 1,
      owedToMe: 1,
      openQuestions: 1,
      mentions: 2,
    });
  });

  it('reconciles counts.mentions with what recentItems can actually render (JJ-75)', async () => {
    const mia = await person('Mia');
    const item1 = await seedItem('2026-01-01T00:00:00.000Z');
    const item2 = await seedItem('2026-02-01T00:00:00.000Z');
    const item3 = await seedItem('2026-03-01T00:00:00.000Z');

    const ent1 = await addExtraction(item1, 'entities', new Date('2026-01-01T02:30:00Z'));
    const ent2 = await addExtraction(item2, 'entities', new Date('2026-02-01T02:30:00Z'));
    const ent3 = await addExtraction(item3, 'entities', new Date('2026-03-01T02:30:00Z'));
    await mention(item1, ent1, mia, 'Mia');
    await mention(item2, ent2, mia, 'Mia');
    await mention(item3, ent3, mia, 'Mia');

    // Simulate a source item that vanished after the mention was recorded (the
    // mention row itself is left behind) — recentItems must drop it silently,
    // and counts.mentions must not keep counting it either.
    await items.delete({ id: item2 });

    const dossier = await service.build(USER, mia);
    expect(dossier.recentItems.map((r) => r.inboxItemId).sort()).toEqual([item1, item3].sort());
    expect(dossier.counts.mentions).toBe(2);
  });

  it('tolerates a commitment whose counterpartyEntityId dangles after a merge', async () => {
    const mia = await person('Mia');
    const item = await seedItem('2026-03-01T00:00:00.000Z');
    const ext = await addExtraction(item, 'facts', new Date('2026-03-01T02:00:00Z'));

    // A valid commitment for Mia…
    await commitments.save(
      commitments.create({
        userId: USER,
        inboxItemId: item,
        extractionId: ext,
        direction: 'owed_by_me',
        counterpartyName: 'Mia',
        counterpartyEntityId: mia,
        description: 'call her back',
        normalizedDescription: 'call her back',
        status: 'open',
        sourceTimestamp: null,
        sourceQuote: null,
        dueDate: null,
      }),
    );
    // …and one pointing at an entity a merge deleted (dangling id).
    await commitments.save(
      commitments.create({
        userId: USER,
        inboxItemId: item,
        extractionId: ext,
        direction: 'owed_by_me',
        counterpartyName: 'Ghost',
        counterpartyEntityId: '00000000-0000-0000-0000-0000000000ff',
        description: 'ghost obligation',
        normalizedDescription: 'ghost obligation',
        status: 'open',
        sourceTimestamp: null,
        sourceQuote: null,
        dueDate: null,
      }),
    );

    // Building Mia's dossier must not crash and must exclude the dangling row.
    const dossier = await service.build(USER, mia);
    expect(dossier.commitments.owedByMe.map((c) => c.description)).toEqual(['call her back']);

    // Building the ghost's dossier 404s (entity gone) — never leaks the row.
    await expect(service.build(USER, '00000000-0000-0000-0000-0000000000ff')).rejects.toThrow();
  });
});

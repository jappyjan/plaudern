import { DataSource, Repository } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
} from '@plaudern/persistence';
import { FactsRegistryService, type FactCandidate } from './facts-registry.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * Exercises the personal-facts store against a real in-memory sqlite DB: dedupe
 * across recordings, append-only supersession, idempotent re-runs, person
 * linkage, and the read models. Mirrors the tasks-registry test strategy.
 */
describe('FactsRegistryService', () => {
  let dataSource: DataSource;
  let service: FactsRegistryService;
  let items: Repository<InboxItemEntity>;
  let extractions: Repository<ExtractedPayloadEntity>;
  let facts: Repository<PersonalFactEntity>;
  let entities: Repository<EntityRegistryEntity>;

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
    facts = dataSource.getRepository(PersonalFactEntity);
    entities = dataSource.getRepository(EntityRegistryEntity);
    service = new FactsRegistryService(
      facts,
      dataSource.getRepository(PersonalFactCitationEntity),
      extractions,
      entities,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Create a committed item + a succeeded `facts` extraction, return their ids. */
  async function seedItem(occurredAt: string, createdAt: Date): Promise<{ itemId: string; extractionId: string }> {
    const item = await items.save(
      items.create({
        userId: USER,
        deviceId: null,
        sourceType: 'plaud' as never,
        occurredAt,
        idempotencyKey: `k-${occurredAt}-${createdAt.getTime()}-${Math.random()}`,
        metadata: null,
      }),
    );
    const extraction = await extractions.save(
      extractions.create({
        inboxItemId: item.id,
        kind: 'facts',
        version: 1,
        provider: 'test:facts',
        status: 'succeeded',
      }),
    );
    // CreateDateColumn is set on insert; pin it so "latest extraction per item"
    // ordering is deterministic across the fast sqlite inserts.
    await extractions.update({ id: extraction.id }, { createdAt });
    return { itemId: item.id, extractionId: extraction.id };
  }

  const candidate = (over: Partial<FactCandidate>): FactCandidate => ({
    person: 'Mia',
    attribute: 'schooling',
    value: 'starts school in August',
    quote: null,
    startSeconds: null,
    ...over,
  });

  it('creates a fact with a citation and lists it active', async () => {
    const { itemId, extractionId } = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const count = await service.ingest(USER, itemId, extractionId, '2026-01-01T00:00:00.000Z', [candidate({})]);
    expect(count).toBe(1);

    const list = await service.list(USER, { includeSuperseded: false });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      personName: 'Mia',
      attribute: 'schooling',
      value: 'starts school in August',
      active: true,
      citationCount: 1,
    });
  });

  it('dedupes the same fact across two recordings into one row with two citations', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-02-01T00:00:00.000Z', new Date('2026-02-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [candidate({})]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-02-01T00:00:00.000Z', [candidate({})]);

    expect(await facts.count()).toBe(1);
    const list = await service.list(USER, { includeSuperseded: false });
    expect(list).toHaveLength(1);
    expect(list[0].citationCount).toBe(2);
  });

  it('supersedes an older fact when a newer recording states a different value, append-only', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-03-01T00:00:00.000Z', new Date('2026-03-02T00:00:00Z'));
    // Same person+attribute, different value → the newer recording supersedes.
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in March' }),
    ]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-03-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in April' }),
    ]);

    // Both rows are retained (append-only) — nothing is hard-deleted on supersede.
    expect(await facts.count()).toBe(2);

    const active = await service.list(USER, { includeSuperseded: false });
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe('in April');
    expect(active[0].active).toBe(true);

    const all = await service.list(USER, { includeSuperseded: true });
    expect(all).toHaveLength(2);
    const march = all.find((f) => f.value === 'in March')!;
    const april = all.find((f) => f.value === 'in April')!;
    expect(march.active).toBe(false);
    expect(march.supersededByFactId).toBe(april.id);
    expect(march.supersededAt).not.toBeNull();
  });

  it('re-running the same item is idempotent (no duplicate facts or citations)', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [candidate({})]);
    // A fresh extraction generation for the SAME item (a reprocess).
    const rerun = await extractions.save(
      extractions.create({ inboxItemId: a.itemId, kind: 'facts', version: 1, provider: 'test:facts', status: 'succeeded' }),
    );
    await extractions.update({ id: rerun.id }, { createdAt: new Date('2026-01-03T00:00:00Z') });
    await service.ingest(USER, a.itemId, rerun.id, '2026-01-01T00:00:00.000Z', [candidate({})]);

    expect(await facts.count()).toBe(1);
    const list = await service.list(USER, { includeSuperseded: false });
    // currentCitations restricts to the latest succeeded extraction per item, so
    // the count stays 1 rather than double-counting the reprocess.
    expect(list[0].citationCount).toBe(1);
  });

  it('links a fact to a registry person when the name matches, and scopes the list', async () => {
    const person = await entities.save(
      entities.create({
        userId: USER,
        type: 'person' as never,
        canonicalName: 'Anna',
        normalizedName: 'anna',
        aliases: [],
      }),
    );
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ person: 'Anna', attribute: 'allergy', value: 'allergic to nuts' }),
    ]);

    const scoped = await service.list(USER, { personEntityId: person.id, includeSuperseded: false });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].personEntityId).toBe(person.id);
    expect(scoped[0].value).toBe('allergic to nuts');
  });
});

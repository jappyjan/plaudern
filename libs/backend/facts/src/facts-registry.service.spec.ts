import { DataSource, In, Repository } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
  recomputePersonalFactSupersession,
} from '@plaudern/persistence';
import { FactsRegistryService, type FactCandidate } from './facts-registry.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * Exercises the personal-facts store against a real in-memory sqlite DB: dedupe
 * across recordings, exclusive-vs-accumulative supersession, order independence,
 * idempotent re-runs, the delete/reprocess invariant recompute, person linkage,
 * and the read models. Mirrors the tasks-registry test strategy.
 */
describe('FactsRegistryService', () => {
  let dataSource: DataSource;
  let service: FactsRegistryService;
  let items: Repository<InboxItemEntity>;
  let extractions: Repository<ExtractedPayloadEntity>;
  let facts: Repository<PersonalFactEntity>;
  let citations: Repository<PersonalFactCitationEntity>;
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
    citations = dataSource.getRepository(PersonalFactCitationEntity);
    entities = dataSource.getRepository(EntityRegistryEntity);
    service = new FactsRegistryService(facts, citations, extractions, entities);
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

  /**
   * Replicate the inbox delete path for one item's facts (InboxService is too
   * heavy to instantiate here): drop the item's citations + extractions, reap
   * facts left with zero citations, un-point pointers at the ghosts, then
   * recompute the affected groups — the exact sequence deleteItem runs.
   */
  async function deleteItemFacts(itemId: string): Promise<void> {
    const cited = await citations.find({ where: { inboxItemId: itemId }, select: { factId: true } });
    const citedIds = [...new Set(cited.map((c) => c.factId))];
    await citations.delete({ inboxItemId: itemId });
    await extractions.delete({ inboxItemId: itemId });
    if (citedIds.length === 0) return;
    const rows = await facts.find({ where: { id: In(citedIds) } });
    const groups = rows.map((f) => ({
      userId: f.userId,
      subjectKey: f.subjectKey,
      normalizedAttribute: f.normalizedAttribute,
    }));
    const remaining = await citations.find({ where: { factId: In(citedIds) }, select: { factId: true } });
    const stillCited = new Set(remaining.map((c) => c.factId));
    const orphaned = citedIds.filter((id) => !stillCited.has(id));
    if (orphaned.length > 0) {
      await facts.update(
        { supersededByFactId: In(orphaned) },
        { supersededByFactId: null, supersededAt: null },
      );
      await facts.delete({ id: In(orphaned) });
    }
    await recomputePersonalFactSupersession(facts.manager, groups);
  }

  const candidate = (over: Partial<FactCandidate>): FactCandidate => ({
    person: 'Mia',
    attribute: 'schooling',
    value: 'starts school in August',
    exclusive: false,
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

  it('keeps two ACCUMULATIVE facts with the same attribute both active (allergies)', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-02-01T00:00:00.000Z', new Date('2026-02-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'allergy', value: 'allergic to nuts', exclusive: false }),
    ]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-02-01T00:00:00.000Z', [
      candidate({ attribute: 'allergy', value: 'allergic to penicillin', exclusive: false }),
    ]);

    const active = await service.list(USER, { includeSuperseded: false });
    expect(active).toHaveLength(2);
    expect(active.every((f) => f.active)).toBe(true);
    expect(new Set(active.map((f) => f.value))).toEqual(
      new Set(['allergic to nuts', 'allergic to penicillin']),
    );
  });

  it('supersedes an older EXCLUSIVE fact when a newer recording states a different value, append-only', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-03-01T00:00:00.000Z', new Date('2026-03-02T00:00:00Z'));
    // Same person + exclusive attribute, different value → the newer recording supersedes.
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in March', exclusive: true }),
    ]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-03-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in April', exclusive: true }),
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

  it('exclusive supersession is order-independent: ingesting the older recording last changes nothing', async () => {
    // Same two recordings as above, PROCESSED in reverse order — the
    // chronologically newer statement (April, occurred March 1st) must win
    // either way because recency is decided by occurredAt, not processing order.
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-03-01T00:00:00.000Z', new Date('2026-03-02T00:00:00Z'));
    await service.ingest(USER, b.itemId, b.extractionId, '2026-03-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in April', exclusive: true }),
    ]);
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in March', exclusive: true }),
    ]);

    const active = await service.list(USER, { includeSuperseded: false });
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe('in April');

    const all = await service.list(USER, { includeSuperseded: true });
    const march = all.find((f) => f.value === 'in March')!;
    const april = all.find((f) => f.value === 'in April')!;
    expect(march.supersededByFactId).toBe(april.id);
  });

  it('deleting the active fact\'s recording re-elects exactly ONE active among the remaining (3-fact group)', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-02-01T00:00:00.000Z', new Date('2026-02-02T00:00:00Z'));
    const c = await seedItem('2026-03-01T00:00:00.000Z', new Date('2026-03-02T00:00:00Z'));
    const city = (value: string) => candidate({ attribute: 'current city', value, exclusive: true });
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [city('Berlin')]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-02-01T00:00:00.000Z', [city('Hamburg')]);
    await service.ingest(USER, c.itemId, c.extractionId, '2026-03-01T00:00:00.000Z', [city('Munich')]);

    // Sanity: Munich (newest) is the sole active fact of the trio.
    let active = await service.list(USER, { includeSuperseded: false });
    expect(active.map((f) => f.value)).toEqual(['Munich']);

    // Delete the recording backing Munich → Munich is reaped (zero citations)
    // and the group must re-elect exactly one active: Hamburg (next-newest),
    // with Berlin superseded BY Hamburg — not a free-for-all of un-pointed rows.
    await deleteItemFacts(c.itemId);

    active = await service.list(USER, { includeSuperseded: false });
    expect(active.map((f) => f.value)).toEqual(['Hamburg']);

    const all = await service.list(USER, { includeSuperseded: true });
    expect(all).toHaveLength(2); // Munich hard-deleted (no citations), rest retained
    const berlin = all.find((f) => f.value === 'Berlin')!;
    const hamburg = all.find((f) => f.value === 'Hamburg')!;
    expect(berlin.supersededByFactId).toBe(hamburg.id);
    expect(hamburg.active).toBe(true);
  });

  it('a reprocess that drops fact A re-activates its superseded sibling B', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-03-01T00:00:00.000Z', new Date('2026-03-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in March', exclusive: true }),
    ]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-03-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in April', exclusive: true }),
    ]);

    // Re-extraction of item B no longer produces the April fact (the model
    // retracted it). April keeps only stale citations → ineligible → March
    // must re-activate, and April must drop out of the active view.
    const rerun = await extractions.save(
      extractions.create({ inboxItemId: b.itemId, kind: 'facts', version: 1, provider: 'test:facts', status: 'succeeded' }),
    );
    await extractions.update({ id: rerun.id }, { createdAt: new Date('2026-03-03T00:00:00Z') });
    await service.ingest(USER, b.itemId, rerun.id, '2026-03-01T00:00:00.000Z', []);

    const active = await service.list(USER, { includeSuperseded: false });
    expect(active.map((f) => f.value)).toEqual(['in March']);
    expect(active[0].active).toBe(true);

    // April's row is retained append-only, just citation-stale and inactive.
    expect(await facts.count()).toBe(2);
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

  it('listWithCitations returns the same facts as list() plus a matching citationRefs map (JJ-75)', async () => {
    const a = await seedItem('2026-01-01T00:00:00.000Z', new Date('2026-01-02T00:00:00Z'));
    const b = await seedItem('2026-02-01T00:00:00.000Z', new Date('2026-02-02T00:00:00Z'));
    await service.ingest(USER, a.itemId, a.extractionId, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'city', value: 'Berlin', exclusive: true, quote: 'lives in Berlin', startSeconds: 12 }),
    ]);
    await service.ingest(USER, b.itemId, b.extractionId, '2026-02-01T00:00:00.000Z', [
      candidate({ attribute: 'city', value: 'Munich', exclusive: true, quote: 'moved to Munich', startSeconds: 34 }),
    ]);

    const plainList = await service.list(USER, { includeSuperseded: true });
    const { facts: combinedList, citationRefs } = await service.listWithCitations(USER, {
      includeSuperseded: true,
    });

    // Same DTOs as the plain list() read model.
    expect(combinedList).toEqual(plainList);

    // The citation map matches what a separate citationRefs() call would
    // compute for the same fact ids — but via the query path list() already ran.
    const separatelyComputed = await service.citationRefs(combinedList.map((f) => f.id));
    for (const fact of combinedList) {
      expect(citationRefs.get(fact.id)).toEqual(separatelyComputed.get(fact.id));
    }
    const active = combinedList.find((f) => f.value === 'Munich')!;
    expect(citationRefs.get(active.id)).toEqual([
      { inboxItemId: b.itemId, quote: 'moved to Munich', startSeconds: 34 },
    ]);
  });
});

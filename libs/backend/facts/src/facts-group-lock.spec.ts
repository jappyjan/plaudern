import type { Repository } from 'typeorm';
import {
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  PersonalFactCitationEntity,
  PersonalFactEntity,
} from '@plaudern/persistence';
import { FactsRegistryService, type FactCandidate } from './facts-registry.service';

const USER = 'user-1';
const ITEM = 'item-1';
const EXTRACTION = 'extraction-1';

/**
 * JJ-72: exercises `lockGroups`, the advisory-lock serialization the ingest
 * transaction takes on each touched (subject, attribute) group right before
 * recomputing supersession. Everything below `em` is faked (a minimal in-memory
 * store), so this asserts the LOCK CALL itself — which query, for which key,
 * and that it's skipped on the sqlite test driver — rather than re-testing
 * supersession correctness (already covered end-to-end against real sqlite in
 * facts-registry.service.spec.ts).
 */
describe('FactsRegistryService group locking (JJ-72)', () => {
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  /** Build a FactsRegistryService whose ingest transaction runs against a fake
   * EntityManager backed by a tiny in-memory PersonalFactEntity store, so
   * `resolveFact` and `recomputePersonalFactSupersession` both function against
   * real (if minimal) data, while every advisory-lock query is captured. */
  function makeService(driverType: 'postgres' | 'better-sqlite3') {
    const queries: { sql: string; params: unknown[] }[] = [];
    const factsStore: Record<string, unknown>[] = [];
    let idCounter = 0;

    const factRepoStub = {
      find: async ({ where }: { where: Record<string, unknown> }) =>
        factsStore.filter((f) => matches(f, where)),
      findOne: async ({ where }: { where: Record<string, unknown> }) =>
        factsStore.find((f) => matches(f, where)) ?? null,
      create: (v: Record<string, unknown>) => ({ ...v }),
      save: async (v: Record<string, unknown>) => {
        if (!v.id) v.id = `fact-${(idCounter += 1)}`;
        const idx = factsStore.findIndex((f) => f.id === v.id);
        if (idx >= 0) factsStore[idx] = v;
        else factsStore.push(v);
        return v;
      },
    };
    const citationRepoStub = {
      find: async () => [] as Record<string, unknown>[],
      findOne: async () => null,
      create: (v: Record<string, unknown>) => ({ ...v }),
      save: async (v: Record<string, unknown>) => v,
    };

    const em = {
      getRepository: (entity: unknown) => {
        if (entity === PersonalFactEntity) return factRepoStub;
        if (entity === PersonalFactCitationEntity) return citationRepoStub;
        throw new Error(`unexpected em.getRepository(${String(entity)})`);
      },
      // recomputePersonalFactSupersession reads/writes via the raw manager,
      // not via getRepository — mirrored here against the same fake store.
      find: async (entity: unknown, opts: { where: Record<string, unknown> }) => {
        if (entity === PersonalFactEntity) return factsStore.filter((f) => matches(f, opts.where));
        return []; // no citations/extractions seeded — every fact reads as citation-stale, a no-op recompute.
      },
      save: async (v: Record<string, unknown>) => v,
      query: async (sql: string, params: unknown[]) => {
        queries.push({ sql, params });
        return [];
      },
    };

    const facts = {
      manager: {
        connection: {
          options: { type: driverType },
          transaction: async (cb: (em: unknown) => Promise<unknown>) => cb(em),
        },
      },
    } as unknown as Repository<PersonalFactEntity>;
    const citations = {} as unknown as Repository<PersonalFactCitationEntity>;
    const extractions = { find: async () => [] } as unknown as Repository<ExtractedPayloadEntity>;
    const entities = { find: async () => [] } as unknown as Repository<EntityRegistryEntity>;

    const service = new FactsRegistryService(facts, citations, extractions, entities);
    return { service, queries };
  }

  const candidate = (over: Partial<FactCandidate>): FactCandidate => ({
    person: 'Mia',
    attribute: 'birthday',
    value: 'in March',
    exclusive: true,
    quote: null,
    startSeconds: null,
    ...over,
  });

  it('takes a transaction-scoped advisory lock on the touched group before recomputing (Postgres)', async () => {
    const { service, queries } = makeService('postgres');
    const count = await service.ingest(USER, ITEM, EXTRACTION, '2026-01-01T00:00:00.000Z', [candidate({})]);
    expect(count).toBe(1);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(queries[0].sql).toContain('hashtextextended');
    // Keyed by (userId, subjectKey, normalizedAttribute) — the group, not the row.
    expect(queries[0].params).toEqual([`${USER}::n:mia::birthday`]);
  });

  it('locks each distinct touched group exactly once, in sorted order', async () => {
    const { service, queries } = makeService('postgres');
    await service.ingest(USER, ITEM, EXTRACTION, '2026-01-01T00:00:00.000Z', [
      candidate({ attribute: 'birthday', value: 'in March' }),
      candidate({ attribute: 'current city', value: 'Berlin' }),
    ]);

    expect(queries).toHaveLength(2);
    const keys = queries.map((q) => q.params[0]);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys)).toEqual(
      new Set([`${USER}::n:mia::birthday`, `${USER}::n:mia::current city`]),
    );
  });

  it('skips the advisory lock entirely on the sqlite test driver', async () => {
    const { service, queries } = makeService('better-sqlite3');
    const count = await service.ingest(USER, ITEM, EXTRACTION, '2026-01-01T00:00:00.000Z', [candidate({})]);
    expect(count).toBe(1);
    expect(queries).toHaveLength(0);
  });
});

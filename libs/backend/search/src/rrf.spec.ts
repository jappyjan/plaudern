import { fuseRankings, rrfScore, RRF_K } from './rrf';

describe('rrfScore', () => {
  it('is 1/(k+rank) and monotonically decreasing in rank', () => {
    expect(rrfScore(1)).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(rrfScore(2)).toBeCloseTo(1 / (RRF_K + 2), 10);
    expect(rrfScore(1)).toBeGreaterThan(rrfScore(2));
  });

  it('honors a custom k', () => {
    expect(rrfScore(1, 1)).toBeCloseTo(0.5, 10);
  });
});

describe('fuseRankings', () => {
  it('sums reciprocal ranks across legs and orders by fused score', () => {
    const fused = fuseRankings([
      { leg: 'semantic', order: ['a', 'b', 'c'] },
      { leg: 'keyword', order: ['b', 'a', 'd'] },
    ]);

    // b: rank1(kw)+rank2(sem); a: rank1(sem)+rank2(kw) — equal sums, so the
    // tie breaks by id ascending → a before b.
    const scoreA = 1 / (RRF_K + 1) + 1 / (RRF_K + 2);
    const scoreB = 1 / (RRF_K + 2) + 1 / (RRF_K + 1);
    expect(fused[0]).toMatchObject({ itemId: 'a', fusedScore: expect.any(Number) });
    expect(fused[0].fusedScore).toBeCloseTo(scoreA, 10);
    expect(fused[1].itemId).toBe('b');
    expect(fused[1].fusedScore).toBeCloseTo(scoreB, 10);
  });

  it('ranks an item found by both legs above items found by only one', () => {
    const fused = fuseRankings([
      { leg: 'semantic', order: ['shared', 'sem-only'] },
      { leg: 'keyword', order: ['shared', 'kw-only'] },
    ]);
    expect(fused[0].itemId).toBe('shared');
    expect(fused[0].ranks).toEqual({ semantic: 1, keyword: 1 });
    // The single-leg items follow, tie-broken by id.
    expect(fused.slice(1).map((f) => f.itemId)).toEqual(['kw-only', 'sem-only']);
  });

  it('records the per-leg rank each item held', () => {
    const [top] = fuseRankings([
      { leg: 'semantic', order: ['x', 'y'] },
      { leg: 'keyword', order: ['y', 'x'] },
    ]);
    expect(top.ranks.semantic).toBeGreaterThanOrEqual(1);
    expect(top.ranks.keyword).toBeGreaterThanOrEqual(1);
  });

  it('keeps only the best occurrence of a duplicated id within a leg', () => {
    const fused = fuseRankings([{ leg: 'keyword', order: ['a', 'a', 'b'] }]);
    const a = fused.find((f) => f.itemId === 'a')!;
    // Only rank 1 counts, not rank 1 + rank 2.
    expect(a.fusedScore).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(a.ranks.keyword).toBe(1);
  });

  it('handles a single leg (semantic unavailable → keyword only)', () => {
    const fused = fuseRankings([{ leg: 'keyword', order: ['a', 'b', 'c'] }]);
    expect(fused.map((f) => f.itemId)).toEqual(['a', 'b', 'c']);
    expect(fused.every((f) => f.ranks.semantic === undefined)).toBe(true);
  });

  it('returns an empty list when no legs contributed', () => {
    expect(fuseRankings([])).toEqual([]);
  });
});

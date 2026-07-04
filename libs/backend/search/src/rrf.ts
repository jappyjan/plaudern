/**
 * Reciprocal Rank Fusion (RRF) — the rank-combination method behind hybrid
 * search. Each retrieval leg contributes a ranked list; an item's fused score
 * is the sum over legs of `1 / (k + rank)` (rank is 1-indexed). RRF needs no
 * score calibration across legs (cosine similarity and ts_rank are on totally
 * different scales), which is exactly why it suits fusing a semantic leg with a
 * keyword leg. `k` damps the influence of low ranks; 60 is the value from the
 * original Cormack et al. paper and the common default.
 */
export const RRF_K = 60;

export type SearchLeg = 'semantic' | 'keyword';

/** A leg's contribution: its identifier plus its best-first ordered item ids. */
export interface LegRanking {
  leg: SearchLeg;
  /** Item ids in descending relevance order (index 0 = rank 1). */
  order: string[];
}

/** One fused item with its per-leg ranks and combined score. */
export interface FusedEntry {
  itemId: string;
  fusedScore: number;
  /** 1-indexed rank the item held in each leg that ranked it. */
  ranks: Partial<Record<SearchLeg, number>>;
}

/** The RRF contribution of a single 1-indexed rank. */
export function rrfScore(rank: number, k: number = RRF_K): number {
  return 1 / (k + rank);
}

/**
 * Fuse leg rankings into a single ordered list. Deterministic: items are sorted
 * by fused score descending, ties broken by item id ascending so the output is
 * stable regardless of leg/input ordering. Duplicate ids within one leg's
 * `order` keep only their first (best) occurrence.
 */
export function fuseRankings(legs: LegRanking[], k: number = RRF_K): FusedEntry[] {
  const byItem = new Map<string, FusedEntry>();

  for (const { leg, order } of legs) {
    const seen = new Set<string>();
    for (let i = 0; i < order.length; i++) {
      const itemId = order[i];
      if (seen.has(itemId)) continue;
      seen.add(itemId);
      const rank = i + 1;
      const entry =
        byItem.get(itemId) ?? { itemId, fusedScore: 0, ranks: {} as FusedEntry['ranks'] };
      entry.fusedScore += rrfScore(rank, k);
      entry.ranks[leg] = rank;
      byItem.set(itemId, entry);
    }
  }

  return [...byItem.values()].sort((a, b) =>
    b.fusedScore !== a.fusedScore ? b.fusedScore - a.fusedScore : a.itemId < b.itemId ? -1 : 1,
  );
}

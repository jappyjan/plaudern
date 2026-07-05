import { createHash } from 'node:crypto';

/** One item's embedding, the unit clustered by the proposer. */
export interface ClusterInput {
  inboxItemId: string;
  vector: number[];
}

/** A discovered cluster of related items. */
export interface Cluster {
  memberItemIds: string[];
}

export interface ClusterOptions {
  /** Cosine similarity (on L2-normalized vectors) at/above which an item joins a cluster. */
  threshold: number;
  /** Clusters smaller than this are dropped — not worth proposing a topic for. */
  minSize: number;
}

export interface ClusterOutcome {
  clusters: Cluster[];
  /**
   * Items skipped because their vector dimension differed from the run's first
   * valid vector (an embedding provider/model switch mid-history). Comparing
   * across dimensions would yield meaningless similarities, so they're dropped;
   * the caller logs the count.
   */
  mismatchedDimensionCount: number;
}

/**
 * Greedy "leader" clustering over item embeddings — dependency-light and
 * fully deterministic given the input order. Each item joins the existing
 * cluster whose running centroid it is closest to (by cosine), provided that
 * similarity clears `threshold`; otherwise it seeds a new cluster. One linear
 * pass, no external ML dependency, and easy to reason about at the recent-item
 * scale the proposer runs on.
 *
 * Vectors are L2-normalized up front so cosine similarity is a plain dot
 * product, and each cluster tracks the sum of its members' normalized vectors
 * (its centroid direction is that sum, itself normalized) so the "closest
 * centroid" test stays O(dims) per comparison. The dimension is pinned to the
 * first valid vector; items with any other dimension are skipped (and counted)
 * rather than silently truncated into nonsense similarities.
 *
 * Returned clusters are filtered to `minSize` and ordered largest-first, so a
 * caller that labels only the top-K proposes the most prominent themes.
 */
export function clusterItems(items: ClusterInput[], options: ClusterOptions): ClusterOutcome {
  const clusters: Array<{ memberItemIds: string[]; centroidSum: number[] }> = [];
  let dims: number | null = null;
  let mismatchedDimensionCount = 0;

  for (const item of items) {
    const unit = normalize(item.vector);
    if (!unit) continue; // zero/empty vector — nothing to compare.
    if (dims === null) {
      dims = unit.length;
    } else if (unit.length !== dims) {
      mismatchedDimensionCount += 1;
      continue;
    }

    let best: (typeof clusters)[number] | null = null;
    let bestSim = -Infinity;
    for (const cluster of clusters) {
      const centroid = normalize(cluster.centroidSum);
      if (!centroid) continue;
      const sim = dot(unit, centroid);
      if (sim > bestSim) {
        bestSim = sim;
        best = cluster;
      }
    }

    if (best && bestSim >= options.threshold) {
      best.memberItemIds.push(item.inboxItemId);
      addInto(best.centroidSum, unit);
    } else {
      clusters.push({ memberItemIds: [item.inboxItemId], centroidSum: [...unit] });
    }
  }

  return {
    clusters: clusters
      .filter((c) => c.memberItemIds.length >= options.minSize)
      .map((c) => ({ memberItemIds: c.memberItemIds }))
      .sort((a, b) => b.memberItemIds.length - a.memberItemIds.length),
    mismatchedDimensionCount,
  };
}

/**
 * Stable identity for a cluster: a hash of its sorted member ids. Two runs that
 * produce the same membership yield the same fingerprint, so a dismissed
 * cluster can be recognized and suppressed on the next run.
 */
export function clusterFingerprint(memberItemIds: string[]): string {
  const sorted = [...memberItemIds].sort();
  return createHash('sha256').update(sorted.join(',')).digest('hex');
}

/**
 * Jaccard overlap of two member sets, in [0, 1]. Used to suppress a fresh
 * cluster that substantially overlaps one the user already dismissed/accepted,
 * so a single new item drifting into an old cluster can't resurrect it.
 */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const id of setA) if (setB.has(id)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** L2-normalize; returns null for a zero-magnitude or empty vector. */
function normalize(vector: number[]): number[] | null {
  let norm = 0;
  for (const v of vector) norm += v * v;
  norm = Math.sqrt(norm);
  if (!(norm > 0)) return null;
  return vector.map((v) => v / norm);
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i] * b[i];
  return sum;
}

function addInto(target: number[], addend: number[]): void {
  const n = Math.min(target.length, addend.length);
  for (let i = 0; i < n; i++) target[i] += addend[i];
}

import { clusterFingerprint, clusterItems, jaccard } from './topic-proposals.clustering';

describe('topic-proposals clustering', () => {
  describe('clusterItems', () => {
    it('groups items by direction and drops clusters below minSize', () => {
      const items = [
        { inboxItemId: 'a1', vector: [1, 0] },
        { inboxItemId: 'a2', vector: [0.98, 0.02] },
        { inboxItemId: 'a3', vector: [0.95, 0.05] },
        { inboxItemId: 'b1', vector: [0, 1] },
        { inboxItemId: 'b2', vector: [0.02, 0.98] },
        { inboxItemId: 'b3', vector: [0.05, 0.95] },
        // A lone outlier — its own cluster, below minSize, so dropped.
        { inboxItemId: 'c1', vector: [-1, -1] },
      ];

      const clusters = clusterItems(items, { threshold: 0.8, minSize: 3 });
      expect(clusters).toHaveLength(2);
      const sets = clusters.map((c) => new Set(c.memberItemIds));
      expect(sets.some((s) => s.has('a1') && s.has('a2') && s.has('a3'))).toBe(true);
      expect(sets.some((s) => s.has('b1') && s.has('b2') && s.has('b3'))).toBe(true);
      // The outlier is in neither surviving cluster.
      expect(clusters.every((c) => !c.memberItemIds.includes('c1'))).toBe(true);
    });

    it('orders clusters largest-first', () => {
      const items = [
        { inboxItemId: 'a1', vector: [1, 0] },
        { inboxItemId: 'a2', vector: [1, 0] },
        { inboxItemId: 'a3', vector: [1, 0] },
        { inboxItemId: 'a4', vector: [1, 0] },
        { inboxItemId: 'b1', vector: [0, 1] },
        { inboxItemId: 'b2', vector: [0, 1] },
      ];
      const clusters = clusterItems(items, { threshold: 0.8, minSize: 2 });
      expect(clusters.map((c) => c.memberItemIds.length)).toEqual([4, 2]);
    });

    it('skips zero/empty vectors without throwing', () => {
      const items = [
        { inboxItemId: 'a1', vector: [1, 0] },
        { inboxItemId: 'z', vector: [0, 0] },
        { inboxItemId: 'a2', vector: [1, 0] },
      ];
      const clusters = clusterItems(items, { threshold: 0.8, minSize: 2 });
      expect(clusters).toHaveLength(1);
      expect(clusters[0].memberItemIds).toEqual(['a1', 'a2']);
    });
  });

  describe('clusterFingerprint', () => {
    it('is stable regardless of member order', () => {
      expect(clusterFingerprint(['b', 'a', 'c'])).toBe(clusterFingerprint(['a', 'b', 'c']));
    });

    it('differs for different memberships', () => {
      expect(clusterFingerprint(['a', 'b'])).not.toBe(clusterFingerprint(['a', 'b', 'c']));
    });
  });

  describe('jaccard', () => {
    it('measures overlap between member sets', () => {
      expect(jaccard(['a', 'b', 'c', 'd'], ['a', 'b', 'c'])).toBeCloseTo(3 / 4);
      expect(jaccard(['a'], ['b'])).toBe(0);
      expect(jaccard([], [])).toBe(1);
    });
  });
});

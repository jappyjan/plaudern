import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { ItemSensitivityEntity } from '@plaudern/persistence';
import { SensitivityRoutingService } from './sensitivity-routing.service';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
}

function makeRepo(rows: Partial<ItemSensitivityEntity>[]): {
  repo: Repository<ItemSensitivityEntity>;
  saved: Partial<ItemSensitivityEntity>[];
} {
  const saved: Partial<ItemSensitivityEntity>[] = [];
  const repo = {
    findOne: async ({ where }: { where: { inboxItemId: string } }) =>
      rows.find((r) => r.inboxItemId === where.inboxItemId) ?? null,
    save: async (row: Partial<ItemSensitivityEntity>) => {
      saved.push(row);
      return row;
    },
    find: async () => rows,
  } as unknown as Repository<ItemSensitivityEntity>;
  return { repo, saved };
}

describe('SensitivityRoutingService', () => {
  describe('resolveTier (pure)', () => {
    it('routes non-sensitive tiers to external', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(svc.resolveTier('normal')).toBe('external');
      expect(svc.resolveTier('public')).toBe('external');
    });

    it('HOLDS sensitive/secret when no local tier is configured', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(svc.localTierConfigured).toBe(false);
      expect(svc.resolveTier('sensitive')).toBe('hold');
      expect(svc.resolveTier('secret')).toBe('hold');
    });

    it('routes sensitive/secret to local when a local tier is configured', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig({ LOCAL_LLM_ENABLED: 'true' }), repo);
      expect(svc.localTierConfigured).toBe(true);
      expect(svc.resolveTier('sensitive')).toBe('local');
      expect(svc.resolveTier('secret')).toBe('local');
    });
  });

  describe('decide (per item)', () => {
    it('waits when the sentinel has not classified the item yet', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('missing')).toBe('wait');
    });

    it('holds a sensitive item with no local tier', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a')).toBe('hold');
    });

    it('releases a sensitive item to local when the tier is configured', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeConfig({ LOCAL_LLM_ENABLED: 'true' }), repo);
      expect(await svc.decide('a')).toBe('local');
    });

    it("respects a user's manual override over the detected tier", async () => {
      // Detected normal, but user marked it sensitive → must not go external.
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'normal', manualTier: 'sensitive' }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a')).toBe('hold');
    });

    it("respects a user's override downgrading a detected-sensitive item", async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: 'normal' }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a')).toBe('external');
    });
  });

  describe('markHeld / clearHeld', () => {
    it('marks an unheld item held with the needs-local reason', async () => {
      const row = { inboxItemId: 'a', held: false, heldReason: null } as Partial<ItemSensitivityEntity>;
      const { repo, saved } = makeRepo([row]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      await svc.markHeld('a');
      expect(saved).toHaveLength(1);
      expect(saved[0].held).toBe(true);
      expect(saved[0].heldReason).toBe('needs-local-model');
    });

    it('is a no-op when already held', async () => {
      const { repo, saved } = makeRepo([{ inboxItemId: 'a', held: true, heldReason: 'needs-local-model' }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      await svc.markHeld('a');
      expect(saved).toHaveLength(0);
    });
  });
});

import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { ItemSensitivityEntity } from '@plaudern/persistence';
import { isLocalEndpoint, SensitivityRoutingService } from './sensitivity-routing.service';

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

// A local endpoint for the summary kind; every other kind keeps its external default.
const LOCAL_SUMMARY = { SUMMARIZATION_BASE_URL: 'http://localhost:11434/v1' };

describe('isLocalEndpoint', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://10.1.2.3:8080/v1',
    'http://192.168.1.50:11434/v1',
    'http://172.16.0.9/v1',
    'http://ollama:11434/v1', // docker service name (single label)
    'http://gpu.local/v1',
    'http://llm.internal/v1',
    'http://[::1]:11434/v1', // IPv6 loopback
    'http://[fd12:3456:789a::1]:11434/v1', // ULA fc00::/7
    'http://[fc00::1]/v1',
    'http://[fe80::1]/v1', // link-local
  ])('treats %s as local', (url) => {
    expect(isLocalEndpoint(url)).toBe(true);
  });

  it.each([
    'https://api.deepseek.com/v1',
    'https://api.openai.com/v1',
    'https://evil.example.com/v1',
    'http://8.8.8.8/v1',
    'http://172.32.0.1/v1', // just outside RFC1918
    'http://169.254.169.254/latest', // cloud metadata (SSRF target)
    'http://[2606:4700::1]/v1', // public IPv6 (Cloudflare) — the shipped-green leak
    'http://[2001:4860:4860::8888]/v1', // public IPv6 (Google DNS)
    'http://[fec0::1]/v1', // deprecated site-local, not fc00::/7 or fe80::/10
    'http://[::]/v1', // unspecified
    '',
    'not-a-url',
    undefined,
  ])('treats %s as NOT local (fail-closed)', (url) => {
    expect(isLocalEndpoint(url as string)).toBe(false);
  });
});

describe('SensitivityRoutingService', () => {
  describe('resolveTier (pure)', () => {
    it('routes non-sensitive tiers to external regardless of endpoint', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(svc.resolveTier('normal', 'summary')).toBe('external');
      expect(svc.resolveTier('public', 'summary')).toBe('external');
    });

    it('HOLDS sensitive/secret when the kind endpoint is external (default)', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(svc.resolveTier('sensitive', 'summary')).toBe('hold');
      expect(svc.resolveTier('secret', 'entities')).toBe('hold');
    });

    it('routes sensitive/secret to local ONLY for a kind pointed at a local endpoint', () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(LOCAL_SUMMARY), repo);
      expect(svc.resolveTier('sensitive', 'summary')).toBe('local');
      // A different kind still on its external default must HOLD, not leak.
      expect(svc.resolveTier('sensitive', 'entities')).toBe('hold');
    });
  });

  describe('decide (per item + kind)', () => {
    it('waits when the sentinel has not classified the item yet', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('missing', 'summary')).toBe('wait');
    });

    it('holds a sensitive item when the kind endpoint is external', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a', 'summary')).toBe('hold');
    });

    it('releases a sensitive item to a local kind endpoint', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeConfig(LOCAL_SUMMARY), repo);
      expect(await svc.decide('a', 'summary')).toBe('local');
    });

    it("respects a user's manual override over the detected tier", async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'normal', manualTier: 'sensitive' }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a', 'summary')).toBe('hold');
    });

    it("respects a user's override downgrading a detected-sensitive item", async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: 'normal' }]);
      const svc = new SensitivityRoutingService(makeConfig(), repo);
      expect(await svc.decide('a', 'summary')).toBe('external');
    });
  });

  describe('INVARIANT: a sensitive/secret item is never released to an external endpoint', () => {
    const gatedKinds = [
      'summary',
      'embedding',
      'entities',
      'relations',
      'topics',
      'commitments',
      'tasks',
      'facts',
      'questions',
      'decisions',
      'reminders',
    ] as const;

    it.each(gatedKinds)(
      'under the default (all external) config, %s HOLDS a secret item',
      async (kind) => {
        const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
        const svc = new SensitivityRoutingService(makeConfig(), repo);
        const decision = await svc.decide('a', kind);
        // Never `external` for a local-only item — only `local` (impossible here,
        // all endpoints external) or `hold`.
        expect(decision).toBe('hold');
        expect(decision).not.toBe('external');
      },
    );

    it('even when a kind endpoint is set to a PUBLIC url, a sensitive item is not released', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const svc = new SensitivityRoutingService(
        makeConfig({ SUMMARIZATION_BASE_URL: 'https://api.deepseek.com/v1' }),
        repo,
      );
      expect(await svc.decide('a', 'summary')).toBe('hold');
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

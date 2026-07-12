import type { Repository } from 'typeorm';
import type { AiCapability } from '@plaudern/contracts';
import type { AiConfigService } from '@plaudern/ai-config';
import type { ItemSensitivityEntity } from '@plaudern/persistence';
import { isLocalEndpoint, SensitivityRoutingService } from './sensitivity-routing.service';

const USER = 'user-1';

/**
 * A fake AiConfigService that resolves each capability to a base URL — the exact
 * per-user DB resolution the provider now uses (#107). `byCapability` overrides a
 * capability's endpoint; unlisted capabilities resolve to the external default,
 * and an explicit `null` means "not configured" (resolve → null).
 */
function makeAiConfig(byCapability: Partial<Record<AiCapability, string | null>> = {}): AiConfigService {
  const DEFAULT = 'https://api.deepseek.com/v1';
  return {
    resolve: async (_userId: string, capability: AiCapability) => {
      const url = capability in byCapability ? byCapability[capability] : DEFAULT;
      return url ? ({ baseUrl: url.replace(/\/+$/, '') } as never) : null;
    },
  } as unknown as AiConfigService;
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

// A local endpoint for the summarization capability; every other capability
// keeps its external default (mirrors a user pointing only summary at Ollama).
const LOCAL_SUMMARY: Partial<Record<AiCapability, string>> = {
  summarization: 'http://localhost:11434/v1',
};

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
    'http://[fd00:ec2::254]/latest/meta-data/', // AWS IMDSv6 metadata (JJ-86 gap)
    'http://[::ffff:169.254.169.254]/latest', // IPv4-mapped metadata address
    '',
    'not-a-url',
    undefined,
  ])('treats %s as NOT local (fail-closed)', (url) => {
    expect(isLocalEndpoint(url as string)).toBe(false);
  });
});

describe('SensitivityRoutingService', () => {
  describe('resolveTier (per user + kind)', () => {
    it('routes non-sensitive tiers to external regardless of endpoint', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.resolveTier('normal', USER, 'summary')).toBe('external');
      expect(await svc.resolveTier('public', USER, 'summary')).toBe('external');
    });

    it('HOLDS sensitive/secret when the kind endpoint is external (default)', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.resolveTier('sensitive', USER, 'summary')).toBe('hold');
      expect(await svc.resolveTier('secret', USER, 'entities')).toBe('hold');
    });

    it('routes sensitive/secret to local ONLY for a kind resolving to a local endpoint', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeAiConfig(LOCAL_SUMMARY), repo);
      expect(await svc.resolveTier('sensitive', USER, 'summary')).toBe('local');
      // A different kind still on its external default must HOLD, not leak.
      expect(await svc.resolveTier('sensitive', USER, 'entities')).toBe('hold');
    });

    it('HOLDS when the capability is unconfigured (resolve → null, fail-closed)', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeAiConfig({ summarization: null }), repo);
      expect(await svc.resolveTier('sensitive', USER, 'summary')).toBe('hold');
    });
  });

  describe('decide (per item + kind, per-user resolution)', () => {
    it('waits when the sentinel has not classified the item yet', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.decide(USER, 'missing', 'summary')).toBe('wait');
    });

    it('holds a sensitive item when the kind endpoint is external', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.decide(USER, 'a', 'summary')).toBe('hold');
    });

    it('releases a sensitive item to a local kind endpoint', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeAiConfig(LOCAL_SUMMARY), repo);
      expect(await svc.decide(USER, 'a', 'summary')).toBe('local');
    });

    it("respects a user's manual override over the detected tier", async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'normal', manualTier: 'sensitive' }]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.decide(USER, 'a', 'summary')).toBe('hold');
    });

    it("respects a user's override downgrading a detected-sensitive item", async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: 'normal' }]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await svc.decide(USER, 'a', 'summary')).toBe('external');
    });

    it('gates the new docmeta kind on the tier just like any text extractor', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const cloud = new SensitivityRoutingService(makeAiConfig(), repo);
      expect(await cloud.decide(USER, 'a', 'docmeta')).toBe('hold');
      const local = new SensitivityRoutingService(
        makeAiConfig({ docmeta: 'http://ollama:11434/v1' }),
        repo,
      );
      expect(await local.decide(USER, 'a', 'docmeta')).toBe('local');
    });
  });

  // The #107 regression: the guard used to read a `<KIND>_BASE_URL` ENV while the
  // provider resolves its endpoint from per-user DB config. These prove the guard
  // now validates the SAME endpoint the provider will actually call.
  describe('REGRESSION (#107): guard resolves the DB endpoint, not stale env', () => {
    it('DB-configured CLOUD endpoint → a sensitive item HOLDS (no leak)', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      // The DB points summarization at a cloud endpoint. (Even if some stale env
      // var said localhost, this service no longer reads env at all.)
      const svc = new SensitivityRoutingService(
        makeAiConfig({ summarization: 'https://api.deepseek.com/v1' }),
        repo,
      );
      expect(await svc.decide(USER, 'a', 'summary')).toBe('hold');
      expect(await svc.decide(USER, 'a', 'summary')).not.toBe('external');
    });

    it('DB-configured LOCAL endpoint → a sensitive item is RELEASED to local', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
      const svc = new SensitivityRoutingService(
        makeAiConfig({ summarization: 'http://127.0.0.1:11434/v1' }),
        repo,
      );
      expect(await svc.decide(USER, 'a', 'summary')).toBe('local');
    });

    it('kindBaseUrl reflects the per-user DB resolution (strips trailing slash)', async () => {
      const { repo } = makeRepo([]);
      const svc = new SensitivityRoutingService(
        makeAiConfig({ topics: 'http://ollama:11434/v1/' }),
        repo,
      );
      expect(await svc.kindBaseUrl(USER, 'topics')).toBe('http://ollama:11434/v1');
      expect(await svc.kindRoutesLocal(USER, 'topics')).toBe(true);
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
      'docmeta',
    ] as const;

    it.each(gatedKinds)(
      'under the default (all external) config, %s HOLDS a secret item',
      async (kind) => {
        const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'secret', manualTier: null }]);
        const svc = new SensitivityRoutingService(makeAiConfig(), repo);
        const decision = await svc.decide(USER, 'a', kind);
        // Never `external` for a local-only item — only `local` (impossible here,
        // all endpoints external) or `hold`.
        expect(decision).toBe('hold');
        expect(decision).not.toBe('external');
      },
    );

    it('even when a DIFFERENT kind is local, a kind still on cloud is not released', async () => {
      const { repo } = makeRepo([{ inboxItemId: 'a', detectedTier: 'sensitive', manualTier: null }]);
      const svc = new SensitivityRoutingService(makeAiConfig(LOCAL_SUMMARY), repo);
      // summary is local → released; entities still cloud → held.
      expect(await svc.decide(USER, 'a', 'summary')).toBe('local');
      expect(await svc.decide(USER, 'a', 'entities')).toBe('hold');
    });
  });

  describe('markHeld / clearHeld', () => {
    it('marks an unheld item held with the needs-local reason', async () => {
      const row = { inboxItemId: 'a', held: false, heldReason: null } as Partial<ItemSensitivityEntity>;
      const { repo, saved } = makeRepo([row]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      await svc.markHeld('a');
      expect(saved).toHaveLength(1);
      expect(saved[0].held).toBe(true);
      expect(saved[0].heldReason).toBe('needs-local-model');
    });

    it('is a no-op when already held', async () => {
      const { repo, saved } = makeRepo([{ inboxItemId: 'a', held: true, heldReason: 'needs-local-model' }]);
      const svc = new SensitivityRoutingService(makeAiConfig(), repo);
      await svc.markHeld('a');
      expect(saved).toHaveLength(0);
    });
  });
});

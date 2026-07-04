import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  ExtractionRunEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import type { ExtractionKind, ExtractionStatus } from '@plaudern/contracts';
import type { Extractor } from '@plaudern/inbox';
import { ExtractorGraph } from './extractor-graph';
import { ExtractionRunsService } from './extraction-runs.service';

const USER_A = '00000000-0000-0000-0000-0000000000aa';
const USER_B = '00000000-0000-0000-0000-0000000000bb';

/** Fake root extractor: applies to everything, records enqueue calls. */
function fakeExtractor(
  kind: ExtractionKind,
  version: number,
  enqueued: string[],
  enabled = true,
): Extractor {
  return {
    kind,
    version,
    dependsOn: [],
    enabled: () => enabled,
    appliesTo: () => true,
    enqueue: async (item) => {
      enqueued.push(item.id);
      return 'new-extraction-id';
    },
  };
}

describe('ExtractionRunsService — startup backfill scan', () => {
  let dataSource: DataSource;
  let enqueued: string[];

  /** Build the service around a graph of the given fake extractors. */
  function buildService(extractors: Extractor[]): ExtractionRunsService {
    return new ExtractionRunsService(
      new ExtractorGraph(extractors),
      dataSource.getRepository(ExtractionRunEntity),
      dataSource.getRepository(InboxItemEntity),
    );
  }

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    enqueued = [];
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createItem(userId: string): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  async function addExtraction(
    inboxItemId: string,
    kind: ExtractionKind,
    status: ExtractionStatus,
    version: number,
  ): Promise<void> {
    await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version,
      provider: 'test',
      status,
      content: null,
    });
  }

  /** Poll until the (fire-and-forget) run reaches a terminal state. */
  async function waitForRun(id: string): Promise<ExtractionRunEntity> {
    for (let i = 0; i < 200; i++) {
      const run = await dataSource.getRepository(ExtractionRunEntity).findOneOrFail({
        where: { id },
      });
      if (run.status !== 'running') return run;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('run did not finish');
  }

  it('enqueues items whose step is MISSING or FAILED or below target version, across all users', async () => {
    // Extractor at version 2.
    const service = buildService([fakeExtractor('transcription', 2, enqueued)]);

    const missing = await createItem(USER_A); // no row → enqueue
    const failed = await createItem(USER_A); // latest failed → enqueue
    const oldVersion = await createItem(USER_A); // succeeded@1 < target 2 → enqueue
    const current = await createItem(USER_A); // succeeded@2 == target → skip
    const inFlight = await createItem(USER_A); // queued (in flight) → skip
    const otherUser = await createItem(USER_B); // no row, different user → enqueue

    await addExtraction(failed, 'transcription', 'failed', 1);
    await addExtraction(oldVersion, 'transcription', 'succeeded', 1);
    await addExtraction(current, 'transcription', 'succeeded', 2);
    await addExtraction(inFlight, 'transcription', 'queued', 2);

    const dto = await service.startStartupBackfill('transcription');
    expect(dto).not.toBeNull();
    expect(dto?.trigger).toBe('startup');

    const run = await waitForRun(dto!.id);
    expect(run.status).toBe('completed');
    expect(run.itemsMatched).toBe(6);
    expect(run.itemsQueued).toBe(4);
    expect(run.itemsSkipped).toBe(2);
    expect(new Set(enqueued)).toEqual(new Set([missing, failed, oldVersion, otherUser]));
  });

  it('is a no-op for a disabled kind (returns null, creates no run)', async () => {
    const service = buildService([fakeExtractor('transcription', 1, enqueued, false)]);
    await createItem(USER_A);

    const dto = await service.startStartupBackfill('transcription');

    expect(dto).toBeNull();
    expect(enqueued).toEqual([]);
    expect(await dataSource.getRepository(ExtractionRunEntity).count()).toBe(0);
  });

  /** Seed an open startup run row (fresh heartbeat, set by save()). */
  async function seedRunningStartupRun(): Promise<ExtractionRunEntity> {
    const runs = dataSource.getRepository(ExtractionRunEntity);
    return runs.save(
      runs.create({
        userId: null,
        kind: 'transcription',
        trigger: 'startup',
        targetVersion: 1,
        force: false,
        occurredFrom: null,
        occurredTo: null,
        status: 'running',
      }),
    );
  }

  it('skip-if-running: a prior startup run with a FRESH heartbeat blocks a new sweep', async () => {
    const service = buildService([fakeExtractor('transcription', 1, enqueued)]);
    const runs = dataSource.getRepository(ExtractionRunEntity);
    const prior = await seedRunningStartupRun(); // save() stamps updatedAt = now

    const dto = await service.startStartupBackfill('transcription');

    expect(dto?.id).toBe(prior.id); // returns the in-flight run, not a new one
    expect(await runs.count()).toBe(1); // no second run created
  });

  it('reboot recovery: a STALE running startup run (dead heartbeat) is failed and superseded', async () => {
    const service = buildService([fakeExtractor('transcription', 1, enqueued)]);
    const runs = dataSource.getRepository(ExtractionRunEntity);
    const item = await createItem(USER_A);
    const stale = await seedRunningStartupRun();
    // Age the heartbeat past the staleness lease — the crash scenario: the
    // previous process was SIGKILLed mid-sweep and never reached finish().
    await dataSource.query(
      `UPDATE "extraction_runs" SET "updatedAt" = datetime('now', '-1 hour') WHERE "id" = ?`,
      [stale.id],
    );

    const dto = await service.startStartupBackfill('transcription');

    // A NEW run was started (the kind is not wedged)...
    expect(dto).not.toBeNull();
    expect(dto?.id).not.toBe(stale.id);
    const fresh = await waitForRun(dto!.id);
    expect(fresh.status).toBe('completed');
    expect(enqueued).toEqual([item]);
    // ...and the stale leftover is marked failed, not left 'running' forever.
    const superseded = await runs.findOneOrFail({ where: { id: stale.id } });
    expect(superseded.status).toBe('failed');
    expect(superseded.error).toContain('stale');
    expect(superseded.completedAt).not.toBeNull();
  });

  describe('listRuns visibility', () => {
    it('hides system startup runs from the default per-user listing, shows them with includeSystem', async () => {
      const service = buildService([fakeExtractor('transcription', 1, enqueued)]);
      const runs = dataSource.getRepository(ExtractionRunEntity);
      await seedRunningStartupRun(); // system-wide (userId null)
      await runs.save(
        runs.create({
          userId: USER_A,
          kind: 'transcription',
          trigger: 'manual',
          targetVersion: 1,
          force: false,
          occurredFrom: null,
          occurredTo: null,
          status: 'completed',
        }),
      );

      const own = await service.listRuns(USER_A);
      expect(own).toHaveLength(1);
      expect(own[0].trigger).toBe('manual');

      const withSystem = await service.listRuns(USER_A, true);
      expect(withSystem).toHaveLength(2);
      expect(withSystem.map((r) => r.trigger).sort()).toEqual(['manual', 'startup']);

      // Another user never sees USER_A's manual run either way.
      const other = await service.listRuns(USER_B);
      expect(other).toHaveLength(0);
    });
  });
});

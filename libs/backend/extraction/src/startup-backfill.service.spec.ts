import type { ConfigService } from '@nestjs/config';
import type { DataSource, QueryRunner } from 'typeorm';
import type { ExtractionKind } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import { ExtractorGraph } from './extractor-graph';
import type { ExtractionRunsService } from './extraction-runs.service';
import { StartupBackfillService } from './startup-backfill.service';

function extractor(
  kind: ExtractionKind,
  enabled: boolean,
  dependsOn: ExtractorDependency[] = [],
): Extractor {
  return {
    kind,
    version: 1,
    dependsOn,
    enabled: () => enabled,
    appliesTo: () => true,
    enqueue: async () => 'id',
  };
}

function fakeConfig(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

/** Records which kinds were asked to backfill; returns a fake run dto. */
function fakeRunsService(): {
  service: ExtractionRunsService;
  calls: ExtractionKind[];
} {
  const calls: ExtractionKind[] = [];
  const service = {
    startStartupBackfill: jest.fn(async (kind: ExtractionKind) => {
      calls.push(kind);
      return { id: `run-${kind}`, kind, status: 'running' };
    }),
  } as unknown as ExtractionRunsService;
  return { service, calls };
}

function sqliteDataSource(): DataSource {
  return {
    options: { type: 'better-sqlite3' },
    createQueryRunner: jest.fn(),
  } as unknown as DataSource;
}

describe('StartupBackfillService', () => {
  it('sweeps only ENABLED kinds, in dependency order (upstream first)', async () => {
    const graph = new ExtractorGraph([
      extractor('transcription', true),
      extractor('diarization', false), // disabled → skipped
      extractor('summary', true, [
        { kind: 'transcription', requires: 'succeeded' },
        { kind: 'diarization', requires: 'settled' },
      ]),
    ]);
    const { service: runs, calls } = fakeRunsService();
    const svc = new StartupBackfillService(fakeConfig(), graph, runs, sqliteDataSource());

    await svc.sweep();

    expect(calls).toEqual(['transcription', 'summary']);
    expect(runs.startStartupBackfill).not.toHaveBeenCalledWith('diarization');
  });

  it('does not touch the DB advisory lock on sqlite (single-process dev)', async () => {
    const graph = new ExtractorGraph([extractor('transcription', true)]);
    const { service: runs } = fakeRunsService();
    const ds = sqliteDataSource();
    const svc = new StartupBackfillService(fakeConfig(), graph, runs, ds);

    await svc.sweep();

    expect(ds.createQueryRunner).not.toHaveBeenCalled();
    expect(runs.startStartupBackfill).toHaveBeenCalledTimes(1);
  });

  describe('multi-replica Postgres advisory lock', () => {
    function pgDataSource(locked: boolean): { ds: DataSource; runner: jest.Mocked<QueryRunner> } {
      const runner = {
        connect: jest.fn(async () => undefined),
        release: jest.fn(async () => undefined),
        query: jest.fn(async (sql: string) => {
          if (sql.includes('pg_try_advisory_lock')) return [{ locked }];
          return [{ 'pg_advisory_unlock': true }];
        }),
      } as unknown as jest.Mocked<QueryRunner>;
      const ds = {
        options: { type: 'postgres' },
        createQueryRunner: jest.fn(() => runner),
      } as unknown as DataSource;
      return { ds, runner };
    }

    it('runs the sweep and releases the lock when it is acquired', async () => {
      const graph = new ExtractorGraph([extractor('transcription', true)]);
      const { service: runs, calls } = fakeRunsService();
      const { ds, runner } = pgDataSource(true);
      const svc = new StartupBackfillService(fakeConfig(), graph, runs, ds);

      await svc.sweep();

      expect(calls).toEqual(['transcription']);
      const sqls = runner.query.mock.calls.map((c) => c[0] as string);
      expect(sqls.some((s) => s.includes('pg_try_advisory_lock'))).toBe(true);
      expect(sqls.some((s) => s.includes('pg_advisory_unlock'))).toBe(true);
      expect(runner.release).toHaveBeenCalled();
    });

    it('SKIPS the sweep when another replica holds the lock (no double-enqueue)', async () => {
      const graph = new ExtractorGraph([extractor('transcription', true)]);
      const { service: runs, calls } = fakeRunsService();
      const { ds, runner } = pgDataSource(false);
      const svc = new StartupBackfillService(fakeConfig(), graph, runs, ds);

      await svc.sweep();

      expect(calls).toEqual([]); // nothing enqueued on this replica
      expect(runs.startStartupBackfill).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled(); // connection still released
    });
  });

  describe('onApplicationBootstrap', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('does nothing when STARTUP_BACKFILL_ENABLED=false', () => {
      const graph = new ExtractorGraph([extractor('transcription', true)]);
      const { service: runs } = fakeRunsService();
      const svc = new StartupBackfillService(
        fakeConfig({ STARTUP_BACKFILL_ENABLED: 'false' }),
        graph,
        runs,
        sqliteDataSource(),
      );

      svc.onApplicationBootstrap();
      jest.advanceTimersByTime(60_000);

      expect(runs.startStartupBackfill).not.toHaveBeenCalled();
    });

    it('arms a delayed, non-blocking sweep when enabled', async () => {
      const graph = new ExtractorGraph([extractor('transcription', true)]);
      const { service: runs } = fakeRunsService();
      const svc = new StartupBackfillService(
        fakeConfig({ STARTUP_BACKFILL_DELAY_MS: '1000' }),
        graph,
        runs,
        sqliteDataSource(),
      );

      svc.onApplicationBootstrap();
      // Not fired yet before the delay elapses (boot is never blocked).
      expect(runs.startStartupBackfill).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();

      expect(runs.startStartupBackfill).toHaveBeenCalledWith('transcription');
    });
  });
});

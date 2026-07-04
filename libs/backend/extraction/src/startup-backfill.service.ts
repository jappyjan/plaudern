import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { ExtractionKind } from '@plaudern/contracts';
import { ExtractorGraph } from './extractor-graph';
import { ExtractionRunsService } from './extraction-runs.service';

/**
 * Postgres advisory-lock key guarding the startup sweep. Any constant works;
 * it only has to be identical across replicas so exactly one holds it at a
 * time. (Chosen arbitrarily; kept in a 32-bit range for readability.)
 */
const STARTUP_BACKFILL_LOCK_KEY = 720_000_028;

/** Default delay before the sweep fires, letting migrations/queues settle. */
const DEFAULT_DELAY_MS = 15_000;

/**
 * Automatic startup backfill (Jan's requirement): on every API boot, for each
 * ENABLED extraction kind in dependency order, find inbox items whose step is
 * missing OR failed for the current extractor version and enqueue them through
 * the EXISTING backfill machinery (ExtractionRunsService) — so merging a new
 * or improved processing step migrates old data on the next deploy, with no
 * manual action.
 *
 * Design notes:
 * - Non-blocking: boot is never delayed. `onApplicationBootstrap` only arms a
 *   timer and returns; the sweep runs asynchronously after a small delay so
 *   migrations have run and queues are ready.
 * - Failed items retry on every reboot — that is explicitly desired (a new
 *   deploy is a new chance). Within a single boot the run walks each item once.
 * - Idempotency across replicas / rapid restarts is enforced two ways:
 *     1. a Postgres advisory lock so only one replica runs the sweep at a time
 *        (skipped on sqlite/local-dev, which is single-process);
 *     2. the runs service's skip-if-running guard, so a kind whose previous
 *        boot's sweep is still running is not enqueued again.
 * - DAG order: kinds are visited upstream-first, but correctness does not
 *   depend on it — the readiness gate skips dependents whose upstreams have not
 *   settled, and the event-driven pipeline (ExtractionPipelineService) enqueues
 *   those dependents automatically once the upstream backfill jobs complete.
 */
@Injectable()
export class StartupBackfillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StartupBackfillService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly graph: ExtractorGraph,
    private readonly runs: ExtractionRunsService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('startup backfill disabled (STARTUP_BACKFILL_ENABLED=false)');
      return;
    }
    const delay = this.delayMs();
    this.logger.log(`startup backfill armed; sweeping in ${delay}ms`);
    // Non-blocking: arm a timer and return so boot is never delayed. `unref`
    // so a pending sweep never keeps the process (or a test) alive.
    this.timer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`startup backfill sweep crashed: ${(err as Error).message}`),
      );
    }, delay);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Run the sweep once: for every enabled kind (dependency order), start a
   * system-wide startup backfill through the runs service. Guarded by an
   * advisory lock so concurrent replicas don't double-enqueue.
   */
  async sweep(): Promise<void> {
    if (this.destroyed) return;
    const kinds = this.enabledKindsInDependencyOrder();
    if (kinds.length === 0) {
      this.logger.log('startup backfill: no enabled extraction kinds — nothing to do');
      return;
    }

    await this.withLock(async () => {
      this.logger.log(
        `startup backfill: sweeping ${kinds.length} enabled kind(s): ${kinds.join(', ')}`,
      );
      for (const kind of kinds) {
        try {
          const run = await this.runs.startStartupBackfill(kind);
          if (run) {
            this.logger.log(
              `startup backfill '${kind}': run ${run.id} (${run.status}) — see counters as it walks items`,
            );
          }
        } catch (err) {
          // One kind failing must not abort the rest of the sweep.
          this.logger.error(
            `startup backfill '${kind}' failed to start: ${(err as Error).message}`,
          );
        }
      }
    });
  }

  private isEnabled(): boolean {
    // Default TRUE: Jan wants migrations of old data to happen automatically.
    return this.config.get<string>('STARTUP_BACKFILL_ENABLED', 'true') !== 'false';
  }

  private delayMs(): number {
    const raw = this.config.get<string>('STARTUP_BACKFILL_DELAY_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
  }

  /**
   * Enabled kinds in topological (upstream-first) order. The graph is validated
   * acyclic at construction, so Kahn's algorithm always drains.
   */
  private enabledKindsInDependencyOrder(): ExtractionKind[] {
    const all = this.graph.all();
    const inDegree = new Map<ExtractionKind, number>();
    for (const extractor of all) inDegree.set(extractor.kind, extractor.dependsOn.length);
    const queue = all.filter((e) => e.dependsOn.length === 0).map((e) => e.kind);
    const order: ExtractionKind[] = [];
    while (queue.length > 0) {
      const kind = queue.shift() as ExtractionKind;
      order.push(kind);
      for (const dependent of this.graph.dependentsOf(kind)) {
        const remaining = (inDegree.get(dependent.kind) ?? 0) - 1;
        inDegree.set(dependent.kind, remaining);
        if (remaining === 0) queue.push(dependent.kind);
      }
    }
    return order.filter((kind) => this.graph.get(kind)?.enabled());
  }

  /**
   * Run `fn` while holding a cross-replica advisory lock. On Postgres a
   * `pg_try_advisory_lock` on a pinned connection ensures exactly one replica
   * runs the sweep; if the lock is already held, this replica skips entirely.
   * On sqlite (local dev / tests) there is only one process, so the lock is a
   * no-op and the runs service's skip-if-running guard suffices.
   */
  private async withLock(fn: () => Promise<void>): Promise<void> {
    if (this.dataSource.options.type !== 'postgres') {
      await fn();
      return;
    }

    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const rows: Array<{ locked: boolean }> = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [STARTUP_BACKFILL_LOCK_KEY],
      );
      const locked = rows[0]?.locked === true;
      if (!locked) {
        this.logger.log(
          'startup backfill: another replica holds the sweep lock — skipping on this instance',
        );
        return;
      }
      try {
        await fn();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [STARTUP_BACKFILL_LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }
}

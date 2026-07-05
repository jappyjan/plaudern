import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { JournalService, type JournalTarget } from './journal.service';

/**
 * Advisory-lock key guarding the journal sweep, distinct from other sweeps so
 * they don't block each other.
 */
const SWEEP_LOCK_KEY = 720_000_039;

/** Default cadence of the sweep (hourly): "by evening" the day is composed. */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
/** Default delay before the first (catch-up) sweep, letting boot settle. */
const DEFAULT_DELAY_MS = 20_000;

/**
 * Drives the auto-journal (JJ-17). On a fixed interval (hourly by default) it
 * (re)composes each day that has fresh signals and each ended week/month/year
 * whose rollup is stale — so "every evening" the day is composed and, once a
 * period ends, its review appears, with no manual action. Idempotent candidate
 * selection (only missing/stale periods) makes repeated ticks cheap and
 * append-only versioning makes re-runs safe.
 *
 * Mirrors the topic-document backfill's guarantees: feature-gated
 * (JOURNAL_SCHEDULER_ENABLED, and the provider must be configured), non-blocking
 * (arms timers and returns), and a Postgres advisory lock so exactly one replica
 * sweeps (a no-op on sqlite/local-dev).
 */
@Injectable()
export class JournalScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JournalScheduler.name);
  private interval?: ReturnType<typeof setInterval>;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly journal: JournalService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('journal scheduler disabled (JOURNAL_SCHEDULER_ENABLED=false)');
      return;
    }
    if (!this.journal.enabled) {
      this.logger.log('journal scheduler skipped — composition is not configured');
      return;
    }
    const intervalMs = this.intervalMs();
    if (intervalMs <= 0) {
      this.logger.log('journal scheduler disabled (JOURNAL_POLL_INTERVAL_MS <= 0)');
      return;
    }

    this.bootTimer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`journal boot sweep crashed: ${(err as Error).message}`),
      );
    }, this.delayMs());
    this.bootTimer.unref?.();

    this.interval = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`journal sweep crashed: ${(err as Error).message}`),
      );
    }, intervalMs);
    this.interval.unref?.();
    this.logger.log(`journal scheduler armed; sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Run one sweep: enqueue every missing/stale day and ended rollup. */
  async sweep(): Promise<void> {
    if (this.destroyed || this.running || !this.journal.enabled) return;
    this.running = true;
    try {
      await this.withLock(async () => {
        const days = await this.journal.daysNeedingComposition();
        const rollups = await this.journal.rollupsNeedingComposition();
        const targets = [...days, ...rollups];
        if (targets.length === 0) {
          this.logger.log('journal sweep: everything up to date — nothing to do');
          return;
        }
        let enqueued = 0;
        for (const t of targets) {
          if (this.destroyed) break;
          enqueued += (await this.enqueue(t)) ? 1 : 0;
        }
        this.logger.log(
          `journal sweep: enqueued ${enqueued} of ${targets.length} (${days.length} day, ${rollups.length} rollup)`,
        );
      });
    } finally {
      this.running = false;
    }
  }

  private async enqueue(t: JournalTarget): Promise<boolean> {
    try {
      return Boolean(await this.journal.enqueueGeneration(t.userId, t.periodType, t.periodKey));
    } catch (err) {
      this.logger.error(
        `journal sweep failed to enqueue ${t.periodType} ${t.periodKey}: ${(err as Error).message}`,
      );
      return false;
    }
  }

  private isEnabled(): boolean {
    return this.config.get<string>('JOURNAL_SCHEDULER_ENABLED', 'true') !== 'false';
  }

  private intervalMs(): number {
    const raw = this.config.get<string>('JOURNAL_POLL_INTERVAL_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
  }

  private delayMs(): number {
    const raw = this.config.get<string>('JOURNAL_SWEEP_DELAY_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_DELAY_MS;
  }

  /** Hold a cross-replica advisory lock while sweeping (no-op on sqlite). */
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
        [SWEEP_LOCK_KEY],
      );
      if (rows[0]?.locked !== true) {
        this.logger.log('journal sweep: another replica holds the lock — skipping');
        return;
      }
      try {
        await fn();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [SWEEP_LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }
}

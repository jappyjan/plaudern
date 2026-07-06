import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { DeadMansSwitchReleaseService } from './dead-mans-switch-release.service';

/** Advisory-lock key guarding the dead-man's-switch sweep (distinct from others). */
const SWEEP_LOCK_KEY = 720_000_049;

/** Default cadence (hourly): a switch tripping is not time-critical to the minute. */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
/** Default delay before the first (catch-up) sweep, letting boot settle. */
const DEFAULT_DELAY_MS = 30_000;

/**
 * Drives the dead-man's-switch release mechanism (JJ-80). On a fixed interval
 * (hourly by default) it sweeps every user with an armed switch and advances it:
 * arming a grace-window release when a check-in has lapsed, then granting the
 * trusted contact scoped emergency access once the window elapses. Firing is
 * idempotent (`dead_mans_switch_release` state), so the contact is emailed
 * exactly once; the sweep is a no-op when nothing is due.
 *
 * Mirrors the JJ-26 nudge scheduler's guarantees: feature-gated
 * (DEAD_MANS_SWITCH_SCHEDULER_ENABLED, default on in prod), non-blocking (arms
 * unref'd timers and returns), and a Postgres advisory lock so exactly one
 * replica sweeps (a no-op on sqlite).
 */
@Injectable()
export class DeadMansSwitchScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DeadMansSwitchScheduler.name);
  private interval?: ReturnType<typeof setInterval>;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly releases: DeadMansSwitchReleaseService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('dead-man’s-switch scheduler disabled (DEAD_MANS_SWITCH_SCHEDULER_ENABLED=false)');
      return;
    }
    const intervalMs = this.intervalMs();
    if (intervalMs <= 0) {
      this.logger.log('dead-man’s-switch scheduler disabled (DEAD_MANS_SWITCH_POLL_INTERVAL_MS <= 0)');
      return;
    }

    this.bootTimer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`dms boot sweep crashed: ${(err as Error).message}`),
      );
    }, this.delayMs());
    this.bootTimer.unref?.();

    this.interval = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`dms sweep crashed: ${(err as Error).message}`),
      );
    }, intervalMs);
    this.interval.unref?.();
    this.logger.log(`dead-man’s-switch scheduler armed; sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Run one sweep: advance every armed switch by one tick. */
  async sweep(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      await this.withLock(async () => {
        const userIds = await this.releases.userIdsWithArmedSwitches();
        if (userIds.length === 0) {
          this.logger.log('dms sweep: no armed switches — nothing to do');
          return;
        }
        let granted = 0;
        for (const userId of userIds) {
          if (this.destroyed) break;
          try {
            granted += await this.releases.sweepUser(userId);
          } catch (err) {
            this.logger.error(`dms sweep failed for user ${userId}: ${(err as Error).message}`);
          }
        }
        this.logger.log(`dms sweep: granted ${granted} release(s) across ${userIds.length} switch(es)`);
      });
    } finally {
      this.running = false;
    }
  }

  private isEnabled(): boolean {
    return this.config.get<string>('DEAD_MANS_SWITCH_SCHEDULER_ENABLED', 'true') !== 'false';
  }

  private intervalMs(): number {
    const raw = this.config.get<string>('DEAD_MANS_SWITCH_POLL_INTERVAL_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
  }

  private delayMs(): number {
    const raw = this.config.get<string>('DEAD_MANS_SWITCH_SWEEP_DELAY_MS');
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
        this.logger.log('dms sweep: another replica holds the lock — skipping');
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

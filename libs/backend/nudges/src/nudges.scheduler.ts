import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { NudgesService } from './nudges.service';

/** Advisory-lock key guarding the nudge sweep, distinct from the other sweeps. */
const SWEEP_LOCK_KEY = 720_000_047;

/** Default cadence of the sweep (hourly): deadlines advance a few times a day. */
const DEFAULT_INTERVAL_MS = 60 * 60_000;
/** Default delay before the first (catch-up) sweep, letting boot settle. */
const DEFAULT_DELAY_MS = 25_000;

/**
 * Drives commitment nudges (JJ-26). On a fixed interval (hourly by default) it
 * sweeps every user with open commitments and fires a proactive notification
 * for each newly-eligible, unresolved nudge — a promise of theirs whose deadline
 * is approaching with no evidence of follow-through, or a stale incoming
 * promise. Firing is idempotent (`nudge_state.nudgedAt`), so a nudge fires once
 * and survives re-extraction; the sweep itself is a no-op when nothing is due.
 *
 * Mirrors the journal scheduler's guarantees: feature-gated
 * (NUDGES_SCHEDULER_ENABLED), non-blocking (arms timers and returns), and a
 * Postgres advisory lock so exactly one replica sweeps (a no-op on sqlite).
 */
@Injectable()
export class NudgesScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(NudgesScheduler.name);
  private interval?: ReturnType<typeof setInterval>;
  private bootTimer?: ReturnType<typeof setTimeout>;
  private running = false;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly nudges: NudgesService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('nudge scheduler disabled (NUDGES_SCHEDULER_ENABLED=false)');
      return;
    }
    const intervalMs = this.intervalMs();
    if (intervalMs <= 0) {
      this.logger.log('nudge scheduler disabled (NUDGES_POLL_INTERVAL_MS <= 0)');
      return;
    }

    this.bootTimer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`nudge boot sweep crashed: ${(err as Error).message}`),
      );
    }, this.delayMs());
    this.bootTimer.unref?.();

    this.interval = setInterval(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`nudge sweep crashed: ${(err as Error).message}`),
      );
    }, intervalMs);
    this.interval.unref?.();
    this.logger.log(`nudge scheduler armed; sweeping every ${intervalMs}ms`);
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.bootTimer) clearTimeout(this.bootTimer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Run one sweep: fire any newly-eligible nudges for every candidate user. */
  async sweep(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;
    try {
      await this.withLock(async () => {
        const userIds = await this.nudges.userIdsWithOpenCommitments();
        if (userIds.length === 0) {
          this.logger.log('nudge sweep: no users with open commitments — nothing to do');
          return;
        }
        let fired = 0;
        for (const userId of userIds) {
          if (this.destroyed) break;
          try {
            fired += await this.nudges.sweepUser(userId);
          } catch (err) {
            this.logger.error(
              `nudge sweep failed for user ${userId}: ${(err as Error).message}`,
            );
          }
        }
        this.logger.log(`nudge sweep: fired ${fired} notification(s) across ${userIds.length} user(s)`);
      });
    } finally {
      this.running = false;
    }
  }

  private isEnabled(): boolean {
    return this.config.get<string>('NUDGES_SCHEDULER_ENABLED', 'true') !== 'false';
  }

  private intervalMs(): number {
    const raw = this.config.get<string>('NUDGES_POLL_INTERVAL_MS');
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : DEFAULT_INTERVAL_MS;
  }

  private delayMs(): number {
    const raw = this.config.get<string>('NUDGES_SWEEP_DELAY_MS');
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
        this.logger.log('nudge sweep: another replica holds the lock — skipping');
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

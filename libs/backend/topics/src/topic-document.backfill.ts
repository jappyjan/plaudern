import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TopicDocumentService } from './topic-document.service';

/**
 * Advisory-lock key guarding the living-document startup sweep. Distinct from
 * the extraction backfill's key so the two sweeps don't block each other.
 */
const BACKFILL_LOCK_KEY = 720_000_036;

/** Default delay before the sweep fires, letting migrations/queues settle. */
const DEFAULT_DELAY_MS = 20_000;

/**
 * Startup backfill for living topic documents (JJ-12). Living documents are a
 * per-TOPIC generation, not a per-item extraction, so they fall outside the
 * ExtractionKind sweep that JJ-67's StartupBackfillService drives. This is the
 * dedicated equivalent: on every API boot, once the feature is enabled, it
 * enqueues a regeneration for every existing topic whose document is missing or
 * stale (an item was classified after the last version), so deploying the
 * feature — or the DeepSeek key — generates documents for existing topics with
 * no manual action.
 *
 * Mirrors StartupBackfillService's guarantees: non-blocking (arms a timer and
 * returns), a Postgres advisory lock so exactly one replica sweeps (a no-op on
 * sqlite/local-dev), and idempotent work selection (only missing/stale topics),
 * so repeated reboots are cheap. Also reaps documents orphaned by topic deletes.
 */
@Injectable()
export class TopicDocumentBackfillService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TopicDocumentBackfillService.name);
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(
    private readonly config: ConfigService,
    private readonly documents: TopicDocumentService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('topic document backfill disabled (TOPIC_DOCS_BACKFILL_ENABLED=false)');
      return;
    }
    if (!this.documents.enabled) {
      this.logger.log('topic document backfill skipped — generation is not configured');
      return;
    }
    const delay = this.delayMs();
    this.logger.log(`topic document backfill armed; sweeping in ${delay}ms`);
    this.timer = setTimeout(() => {
      void this.sweep().catch((err) =>
        this.logger.error(`topic document backfill crashed: ${(err as Error).message}`),
      );
    }, delay);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Run the sweep once: reap orphans, then enqueue missing/stale documents. */
  async sweep(): Promise<void> {
    if (this.destroyed || !this.documents.enabled) return;
    await this.withLock(async () => {
      const orphans = await this.documents.pruneOrphans();
      if (orphans > 0) this.logger.log(`topic document backfill: reaped ${orphans} orphan(s)`);

      const targets = await this.documents.topicsNeedingRegeneration();
      if (targets.length === 0) {
        this.logger.log('topic document backfill: all topics up to date — nothing to do');
        return;
      }
      this.logger.log(`topic document backfill: regenerating ${targets.length} topic document(s)`);
      let enqueued = 0;
      for (const { userId, topicId } of targets) {
        if (this.destroyed) break;
        try {
          if (await this.documents.enqueueRegeneration(userId, topicId)) enqueued += 1;
        } catch (err) {
          this.logger.error(
            `topic document backfill failed to enqueue topic ${topicId}: ${(err as Error).message}`,
          );
        }
      }
      this.logger.log(`topic document backfill: enqueued ${enqueued} regeneration(s)`);
    });
  }

  private isEnabled(): boolean {
    return this.config.get<string>('TOPIC_DOCS_BACKFILL_ENABLED', 'true') !== 'false';
  }

  private delayMs(): number {
    const raw = this.config.get<string>('TOPIC_DOCS_BACKFILL_DELAY_MS');
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
        [BACKFILL_LOCK_KEY],
      );
      if (rows[0]?.locked !== true) {
        this.logger.log('topic document backfill: another replica holds the lock — skipping');
        return;
      }
      try {
        await fn();
      } finally {
        await runner.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_KEY]);
      }
    } finally {
      await runner.release();
    }
  }
}

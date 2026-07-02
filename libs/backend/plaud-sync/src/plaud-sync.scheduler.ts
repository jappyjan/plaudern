import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PlaudSyncService } from './plaud-sync.service';

/**
 * Kicks off a Plaud sync on a fixed interval. A plain interval (not a BullMQ
 * repeatable job) because the app is single-instance and the dev/test default
 * runs without Redis; syncNow() itself no-ops unless settings are enabled.
 */
@Injectable()
export class PlaudSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlaudSyncScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly sync: PlaudSyncService,
  ) {}

  onApplicationBootstrap(): void {
    const ms = Number(this.config.get<string>('PLAUD_POLL_INTERVAL_MS', '300000'));
    if (!Number.isFinite(ms) || ms <= 0) {
      this.logger.log('plaud sync poller disabled (PLAUD_POLL_INTERVAL_MS <= 0)');
      return;
    }
    const timer = setInterval(() => {
      void this.sync
        .syncNow()
        .catch((err: unknown) =>
          this.logger.error(`plaud sync tick failed: ${err instanceof Error ? err.message : err}`),
        );
    }, ms);
    // Don't keep the process alive just for the poller (matters for tests/CLI).
    timer.unref();
    this.registry.addInterval('plaud-sync', timer);
    this.logger.log(`plaud sync poller scheduled every ${ms}ms`);
  }
}

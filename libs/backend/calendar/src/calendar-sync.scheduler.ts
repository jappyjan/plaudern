import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CalendarSyncService } from './calendar-sync.service';

/**
 * Kicks off a calendar sync on a fixed interval. A plain interval (not a
 * BullMQ repeatable job) because the app is single-instance and the dev/test
 * default runs without Redis; syncNow() itself no-ops without enabled feeds.
 */
@Injectable()
export class CalendarSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CalendarSyncScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly sync: CalendarSyncService,
  ) {}

  onApplicationBootstrap(): void {
    const ms = Number(this.config.get<string>('CALENDAR_POLL_INTERVAL_MS', '900000'));
    if (!Number.isFinite(ms) || ms <= 0) {
      this.logger.log('calendar sync poller disabled (CALENDAR_POLL_INTERVAL_MS <= 0)');
      return;
    }
    const timer = setInterval(() => {
      void this.sync
        .syncNow()
        .catch((err: unknown) =>
          this.logger.error(
            `calendar sync tick failed: ${err instanceof Error ? err.message : err}`,
          ),
        );
    }, ms);
    // Don't keep the process alive just for the poller (matters for tests/CLI).
    timer.unref();
    this.registry.addInterval('calendar-sync', timer);
    this.logger.log(`calendar sync poller scheduled every ${ms}ms`);
  }
}

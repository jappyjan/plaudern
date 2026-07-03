import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { CalendarSyncNowResponse } from '@plaudern/contracts';
import { CalendarEventEntity, CalendarFeedEntity } from '@plaudern/persistence';
import { CALENDAR_PROVIDERS, type CalendarProvider, type NormalizedCalendarEvent } from './provider';
import { CalendarFeedsService } from './calendar-feeds.service';
import { CalendarLinkService } from './calendar-link.service';

export const SYNC_WINDOW_PAST_DAYS = 90;
export const SYNC_WINDOW_FUTURE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pulls events from enabled feeds into the calendar_events cache, then
 * re-runs the auto-link pass once per affected user. The scheduler syncs
 * every user's feeds; manual triggers sync only the acting user's. Mirrors
 * PlaudSyncService: in-process mutex, per-feed status, single instance.
 */
@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);
  /** In-process mutex; the app is single-instance by design. */
  private running = false;

  constructor(
    private readonly feeds: CalendarFeedsService,
    private readonly links: CalendarLinkService,
    @InjectRepository(CalendarEventEntity)
    private readonly events: Repository<CalendarEventEntity>,
    @Inject(CALENDAR_PROVIDERS) private readonly providers: CalendarProvider[],
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Entry point for the interval (no userId: all users), the manual trigger
   * and feed creation (userId: just that user's feeds).
   */
  async syncNow(userId?: string): Promise<CalendarSyncNowResponse> {
    if (this.running) return { started: false, alreadyRunning: true };
    // Claim the mutex synchronously with the check so concurrent callers
    // can't both pass it before the first await.
    this.running = true;
    try {
      const enabled = await this.feeds.listEnabled(userId);
      if (enabled.length === 0) return { started: false, alreadyRunning: false };
      await this.runSync(enabled);
      return { started: true, alreadyRunning: false };
    } finally {
      this.running = false;
    }
  }

  private async runSync(feeds: CalendarFeedEntity[]): Promise<void> {
    const windowStart = new Date(Date.now() - SYNC_WINDOW_PAST_DAYS * DAY_MS);
    const windowEnd = new Date(Date.now() + SYNC_WINDOW_FUTURE_DAYS * DAY_MS);

    // Sequential and individually guarded: one broken feed must not block the
    // others, and per-feed status makes the failure visible in settings.
    for (const feed of feeds) {
      try {
        const provider = this.providerFor(feed);
        const fetched = await provider.fetchEvents(feed, windowStart, windowEnd);
        const count = await this.storeEvents(feed, fetched, windowStart, windowEnd);
        await this.feeds.recordSyncResult(feed.id, { status: 'ok', eventCount: count });
        this.logger.log(`calendar sync: feed ${feed.urlMasked} → ${count} events in window`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`calendar sync: feed ${feed.urlMasked} failed — ${message}`);
        await this.feeds.recordSyncResult(feed.id, { status: 'error', error: message });
      }
    }

    // Auto-linking joins each user's own recordings and events — run it once
    // per user represented in this sync batch.
    for (const userId of new Set(feeds.map((feed) => feed.userId))) {
      try {
        await this.links.autoLinkWindow(userId, windowStart, windowEnd);
      } catch (err) {
        this.logger.error(
          `calendar sync: auto-link pass failed — ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  private providerFor(feed: CalendarFeedEntity): CalendarProvider {
    const provider = this.providers.find((candidate) => candidate.type === feed.providerType);
    if (!provider) throw new Error(`no calendar provider registered for '${feed.providerType}'`);
    return provider;
  }

  /**
   * Upserts fetched instances by (feedId, externalUid, instanceStart) — so
   * uuid PKs (and links pointing at them) survive syncs — and deletes
   * window-resident instances that vanished from the feed (cancelled/moved);
   * their links go with them via FK cascade.
   */
  private async storeEvents(
    feed: CalendarFeedEntity,
    fetched: NormalizedCalendarEvent[],
    windowStart: Date,
    windowEnd: Date,
  ): Promise<number> {
    const existing = await this.events.find({ where: { feedId: feed.id } });
    const existingByIdentity = new Map<string, CalendarEventEntity>(
      existing.map((event) => [identityKey(event.externalUid, event.instanceStart), event]),
    );

    const seen = new Set<string>();
    for (const incoming of fetched) {
      const key = identityKey(incoming.externalUid, incoming.instanceStart);
      if (seen.has(key)) continue; // defensive: a feed repeating an instance
      seen.add(key);
      const current = existingByIdentity.get(key);
      if (current) {
        if (eventChanged(current, incoming)) {
          Object.assign(current, projectEvent(incoming));
          await this.events.save(current);
        }
      } else {
        await this.events.save(
          this.events.create({
            userId: feed.userId,
            feedId: feed.id,
            externalUid: incoming.externalUid,
            instanceStart: incoming.instanceStart,
            ...projectEvent(incoming),
          }),
        );
      }
    }

    // Only instances whose original occurrence lies inside the fetch window
    // are eligible for deletion — anything outside it simply wasn't fetched.
    const staleIds = existing
      .filter(
        (event) =>
          !seen.has(identityKey(event.externalUid, event.instanceStart)) &&
          event.instanceStart >= windowStart.toISOString() &&
          event.instanceStart <= windowEnd.toISOString(),
      )
      .map((event) => event.id);
    if (staleIds.length > 0) {
      await this.events.delete({ id: In(staleIds) });
      this.logger.log(`calendar sync: feed ${feed.urlMasked} — ${staleIds.length} events removed`);
    }

    return seen.size;
  }
}

function identityKey(externalUid: string, instanceStart: string): string {
  return `${externalUid}|${instanceStart}`;
}

function projectEvent(event: NormalizedCalendarEvent) {
  return {
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay,
    title: event.title,
    description: event.description,
    location: event.location,
    timezone: event.timezone,
  };
}

function eventChanged(current: CalendarEventEntity, incoming: NormalizedCalendarEvent): boolean {
  return (
    current.startAt !== incoming.startAt ||
    current.endAt !== incoming.endAt ||
    current.isAllDay !== incoming.isAllDay ||
    current.title !== incoming.title ||
    current.description !== incoming.description ||
    current.location !== incoming.location ||
    current.timezone !== incoming.timezone
  );
}

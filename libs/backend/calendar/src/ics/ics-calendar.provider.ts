import { Injectable, Logger } from '@nestjs/common';
import type { CalendarFeedEntity } from '@plaudern/persistence';
import type {
  CalendarProvider,
  CalendarTestResult,
  NormalizedCalendarEvent,
} from '../provider';
import { CalendarFeedsService } from '../calendar-feeds.service';
import { IcsFeedClient, maskFeedUrl } from './ics-feed.client';
import { expandIcsEvents } from './ics-parser';

/** Read-only ICS feed subscriptions — provider #1 (Google/Outlook/iCloud secret URLs). */
@Injectable()
export class IcsCalendarProvider implements CalendarProvider {
  readonly type = 'ics' as const;
  private readonly logger = new Logger(IcsCalendarProvider.name);

  constructor(
    private readonly client: IcsFeedClient,
    private readonly feeds: CalendarFeedsService,
  ) {}

  async fetchEvents(
    feed: CalendarFeedEntity,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<NormalizedCalendarEvent[]> {
    const url = this.feeds.getDecryptedUrl(feed);
    const body = await this.client.download(url);
    const { events, truncated } = expandIcsEvents(body, windowStart, windowEnd);
    if (truncated) {
      this.logger.warn(`feed ${feed.urlMasked}: expansion capped, some instances dropped`);
    }
    return events;
  }

  async testConnection(rawUrl: string): Promise<CalendarTestResult> {
    try {
      const body = await this.client.download(rawUrl);
      // Small window around now — enough to prove the feed parses and count something.
      const now = Date.now();
      const windowStart = new Date(now - 45 * 24 * 60 * 60 * 1000);
      const windowEnd = new Date(now + 45 * 24 * 60 * 60 * 1000);
      const { calendarName, events } = expandIcsEvents(body, windowStart, windowEnd);
      return { ok: true, error: null, eventCount: events.length, calendarName };
    } catch (err) {
      this.logger.warn(
        `test of feed ${maskFeedUrl(rawUrl)} failed: ${err instanceof Error ? err.message : err}`,
      );
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        eventCount: null,
        calendarName: null,
      };
    }
  }
}

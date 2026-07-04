import { Injectable } from '@nestjs/common';
import type { CalendarFeedEntity } from '@plaudern/persistence';
import type { CalendarProvider, CalendarTestResult, NormalizedCalendarEvent } from '../provider';
import { CalendarFeedsService } from '../calendar-feeds.service';
import { GoogleCalendarClient } from './google-calendar.client';

/** Read-only native Google Calendar via per-user OAuth — provider #2. */
@Injectable()
export class GoogleCalendarProvider implements CalendarProvider {
  readonly type = 'google' as const;

  constructor(
    private readonly client: GoogleCalendarClient,
    private readonly feeds: CalendarFeedsService,
  ) {}

  async fetchEvents(
    feed: CalendarFeedEntity,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<NormalizedCalendarEvent[]> {
    const refreshToken = this.feeds.getDecryptedRefreshToken(feed);
    const accessToken = await this.client.refreshAccessToken(refreshToken);
    return this.client.listEvents(accessToken, feed.googleCalendarId as string, windowStart, windowEnd);
  }

  async testConnection(): Promise<CalendarTestResult> {
    // Google feeds are validated at OAuth time, not via a URL.
    return { ok: false, error: 'not supported for google feeds', eventCount: null, calendarName: null };
  }
}

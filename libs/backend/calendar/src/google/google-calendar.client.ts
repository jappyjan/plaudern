import { Inject, Injectable } from '@nestjs/common';
import type { NormalizedCalendarEvent } from '../provider';
import { CALENDAR_FETCH, type FetchLike } from '../ics/ics-feed.client';

export const GOOGLE_OAUTH_CONFIG = Symbol('GOOGLE_OAUTH_CONFIG');

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface GoogleCalendarSummary {
  id: string;
  summary: string;
  primary: boolean;
}

/** Thrown when Google rejects the refresh token (revoked/expired) — surfaced as "reconnect". */
export class GoogleAuthError extends Error {}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_LIST_URL = 'https://www.googleapis.com/calendar/v3/users/me/calendarList';
const EVENTS_BASE = 'https://www.googleapis.com/calendar/v3/calendars';
// Mirror the ICS expansion cap so one huge calendar can't blow up memory.
const MAX_INSTANCES = 5000;

/** Maps one Google events.list item to a normalized event, or null to skip it. */
export function mapGoogleEvent(raw: unknown): NormalizedCalendarEvent | null {
  const item = raw as {
    id?: string;
    status?: string;
    summary?: string;
    description?: string;
    location?: string;
    start?: { dateTime?: string; date?: string; timeZone?: string };
    end?: { dateTime?: string; date?: string; timeZone?: string };
  };
  if (!item.id || item.status === 'cancelled' || !item.start) return null;

  const isAllDay = Boolean(item.start.date);
  const startAt = isAllDay
    ? `${item.start.date}T00:00:00.000Z`
    : new Date(item.start.dateTime as string).toISOString();
  const endRaw = item.end?.date ?? item.end?.dateTime;
  const endAt = item.end?.date
    ? `${item.end.date}T00:00:00.000Z`
    : endRaw
      ? new Date(endRaw).toISOString()
      : startAt;

  return {
    externalUid: item.id,
    instanceStart: startAt,
    startAt,
    endAt,
    isAllDay,
    title: item.summary ?? null,
    description: item.description ?? null,
    location: item.location ?? null,
    timezone: item.start.timeZone ?? null,
  };
}

@Injectable()
export class GoogleCalendarClient {
  constructor(
    @Inject(CALENDAR_FETCH) private readonly fetch: FetchLike,
    @Inject(GOOGLE_OAUTH_CONFIG) private readonly config: GoogleOAuthConfig,
  ) {}

  async exchangeCode(
    code: string,
  ): Promise<{ tokens: GoogleTokens; calendars: GoogleCalendarSummary[]; email: string }> {
    const body = new URLSearchParams({
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.config.redirectUri,
      grant_type: 'authorization_code',
    });
    const json = await this.postToken(body);
    const tokens: GoogleTokens = {
      accessToken: json.access_token as string,
      refreshToken: (json.refresh_token as string | undefined) ?? null,
    };
    const calendars = await this.listCalendars(tokens.accessToken);
    const primary = calendars.find((c) => c.primary);
    // For a Google account the primary calendar id IS the account email.
    const email = primary?.id ?? calendars[0]?.id ?? 'unknown';
    return { tokens, calendars, email };
  }

  async refreshAccessToken(refreshToken: string): Promise<string> {
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });
    const json = await this.postToken(body);
    return json.access_token as string;
  }

  private async postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = String(json.error ?? res.status);
      if (err === 'invalid_grant') {
        throw new GoogleAuthError('Google authorization expired — reconnect the calendar in settings');
      }
      throw new Error(`google token request failed: ${err}`);
    }
    return json;
  }

  private async listCalendars(accessToken: string): Promise<GoogleCalendarSummary[]> {
    const res = await this.fetch(CALENDAR_LIST_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`google calendarList failed: ${res.status}`);
    const json = (await res.json()) as { items?: Array<{ id: string; summary?: string; primary?: boolean }> };
    return (json.items ?? []).map((c) => ({
      id: c.id,
      summary: c.summary ?? c.id,
      primary: Boolean(c.primary),
    }));
  }

  async listEvents(
    accessToken: string,
    calendarId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<NormalizedCalendarEvent[]> {
    const events: NormalizedCalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin: windowStart.toISOString(),
        timeMax: windowEnd.toISOString(),
        maxResults: '2500',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const url = `${EVENTS_BASE}/${encodeURIComponent(calendarId)}/events?${params}`;
      const res = await this.fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
      if (res.status === 401) {
        throw new GoogleAuthError('Google authorization expired — reconnect the calendar in settings');
      }
      if (!res.ok) throw new Error(`google events.list failed: ${res.status}`);
      const json = (await res.json()) as { items?: unknown[]; nextPageToken?: string };
      for (const item of json.items ?? []) {
        const mapped = mapGoogleEvent(item);
        if (mapped) events.push(mapped);
        if (events.length >= MAX_INSTANCES) return events; // ponytail: cap mirrors ICS; drop the tail
      }
      pageToken = json.nextPageToken;
    } while (pageToken);
    return events;
  }
}

import { randomBytes } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CalendarFeedEntity } from '@plaudern/persistence';
import { CalendarFeedsService } from '../calendar-feeds.service';
import {
  GOOGLE_OAUTH_CONFIG,
  GoogleCalendarClient,
  type GoogleCalendarSummary,
  type GoogleOAuthConfig,
} from './google-calendar.client';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const TTL_MS = 10 * 60 * 1000;

interface StateEntry {
  expiresAt: number;
  userId: string;
}

interface Pending {
  userId: string;
  email: string;
  refreshToken: string;
  calendars: GoogleCalendarSummary[];
  expiresAt: number;
}

/** OAuth orchestration. `ponytail:` state + pending live in-memory — the app is
 *  single-instance (Coolify, one container). Move to a short-lived DB/Redis key
 *  only if horizontally scaled or if losing an in-flight connect on restart matters. */
@Injectable()
export class GoogleOAuthService {
  private readonly states = new Map<string, StateEntry>(); // state -> {expiresAt, userId}
  private readonly pending = new Map<string, Pending>();

  constructor(
    @Inject(GOOGLE_OAUTH_CONFIG) private readonly config: GoogleOAuthConfig & { appBaseUrl: string },
    private readonly client: GoogleCalendarClient,
    private readonly feeds: CalendarFeedsService,
  ) {}

  isConfigured(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret && this.config.redirectUri);
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'Google Calendar is not configured on the server (set GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI)',
      );
    }
  }

  /** The connecting user's id is carried in the OAuth `state` so the (public,
   *  session-less) callback can attribute the connection back to them. */
  buildAuthUrl(userId: string): string {
    this.requireConfigured();
    const state = randomBytes(16).toString('hex');
    this.states.set(state, { expiresAt: Date.now() + TTL_MS, userId });
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async handleCallback(code: string, state: string): Promise<string> {
    this.requireConfigured();
    const entry = this.states.get(state);
    this.states.delete(state);
    if (!entry || entry.expiresAt < Date.now()) {
      throw new BadRequestException('invalid or expired OAuth state');
    }
    const { tokens, calendars, email } = await this.client.exchangeCode(code);
    if (!tokens.refreshToken) {
      throw new BadRequestException(
        'Google did not return a refresh token — remove app access in your Google account and reconnect',
      );
    }
    const id = randomBytes(16).toString('hex');
    this.pending.set(id, {
      userId: entry.userId,
      email,
      refreshToken: tokens.refreshToken,
      calendars,
      expiresAt: Date.now() + TTL_MS,
    });
    // Relative redirect: the SPA is served same-origin behind the proxy. `ponytail:`
    // set GOOGLE_APP_BASE_URL if the SPA lives on a different origin.
    const base = this.config.appBaseUrl || '';
    return `${base}/settings?googlePending=${id}`;
  }

  getPending(userId: string, id: string): { email: string; calendars: GoogleCalendarSummary[] } {
    const entry = this.resolvePending(id, userId);
    return { email: entry.email, calendars: entry.calendars };
  }

  async confirmFeeds(
    userId: string,
    pendingId: string,
    calendarIds: string[],
  ): Promise<CalendarFeedEntity[]> {
    const entry = this.resolvePending(pendingId, userId);
    const chosen = entry.calendars.filter((c) => calendarIds.includes(c.id));
    if (chosen.length === 0)
      throw new BadRequestException('none of the selected calendars exist in this connection');
    const feeds = await this.feeds.createGoogleFeeds(userId, {
      email: entry.email,
      refreshToken: entry.refreshToken,
      calendars: chosen,
    });
    this.pending.delete(pendingId);
    return feeds;
  }

  async reconnect(userId: string, pendingId: string): Promise<number> {
    const entry = this.resolvePending(pendingId, userId);
    const count = await this.feeds.updateGoogleRefreshToken(userId, entry.email, entry.refreshToken);
    this.pending.delete(pendingId);
    return count;
  }

  private resolvePending(id: string, userId: string): Pending {
    const entry = this.pending.get(id);
    if (!entry || entry.expiresAt < Date.now()) {
      this.pending.delete(id);
      throw new NotFoundException('this Google connection expired — start again');
    }
    // Don't delete on owner mismatch — that would let one user evict another's
    // in-flight connection. The id is unguessable, so this is defense-in-depth.
    if (entry.userId !== userId) {
      throw new NotFoundException('this Google connection expired — start again');
    }
    return entry;
  }
}

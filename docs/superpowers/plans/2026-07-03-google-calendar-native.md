# Native Google Calendar Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users subscribe to Google calendars via per-user OAuth (read-only), so company accounts that block ICS export can still be captured.

**Architecture:** A new `GoogleCalendarProvider` implements the existing `CalendarProvider` interface and registers in `CALENDAR_PROVIDERS`, so Google feeds flow through the unchanged sync → store → auto-link pipeline. One Google calendar = one `calendar_feeds` row (`providerType='google'`), carrying the calendar id + an encrypted refresh token. OAuth uses the authorization-code flow with in-memory state/pending stores (single-instance deployment). Google's `events.list?singleEvents=true` expands recurring events server-side, so there is no RRULE handling. No new npm dependency — token exchange and the two REST calls are plain `fetch`, reusing the injectable `CALENDAR_FETCH`.

**Tech Stack:** NestJS + TypeORM (Postgres/sqlite), Zod contracts, React 19 + Vite + HeroUI, `node:crypto` (existing AES-256-GCM helper).

## Global Constraints

- **No new npm dependency.** OAuth token exchange, `calendarList.list`, `events.list` are plain `fetch` via the injected `CALENDAR_FETCH` token (`FetchLike`). Do NOT add `googleapis`/`google-auth-library`.
- **Read-only scope only:** `https://www.googleapis.com/auth/calendar.readonly`. No write-back.
- **Refresh tokens are secrets** — store only via `encryptSecret(plain, secret)` (AES-256-GCM, format `v1:<iv>:<tag>:<data>`); the encryption secret is `config.get('APP_ENCRYPTION_SECRET')`. Never return a refresh token in any DTO/response.
- **Single instance:** in-memory `state` and `pending` maps are acceptable; mark each with a `ponytail:` comment naming the single-instance ceiling.
- **Feature gates on config:** if `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` are not all set, Google endpoints return a clear "not configured" error and the UI hides the Connect button. ICS behavior must be unaffected.
- **Normalized event identity** is `(externalUid, instanceStart)` per feed; timestamps are ISO 8601 UTC; all-day events are UTC calendar-date midnights (`YYYY-MM-DDT00:00:00.000Z`).
- Tests run under sqlite with `synchronize: true`, so new entity columns exist in tests without the migration; the migration matters for Postgres prod only.

---

## File Structure

**Backend — new files** (under `libs/backend/calendar/src/google/`):
- `google-calendar.client.ts` — raw Google REST + OAuth token calls, maps events to `NormalizedCalendarEvent`.
- `google-calendar.client.spec.ts` — mapping/paging/error tests.
- `google-calendar.provider.ts` — implements `CalendarProvider` for `providerType='google'`.
- `google-oauth.service.ts` — config gate, state + pending stores, auth-url/callback orchestration.
- `google-oauth.service.spec.ts` — state validation + pending lifecycle tests.

**Backend — modified:**
- `libs/contracts/src/calendar.ts` — add `'google'` to provider enum; add Google request/response schemas; add `googleConfigured` to feeds response.
- `libs/backend/persistence/src/entities/calendar-feed.entity.ts` — new nullable columns; relax `url*` to nullable.
- `libs/backend/persistence/src/migrations/1720000000007-GoogleCalendarFeeds.ts` — new migration (create + register in `persistence.module.ts`).
- `libs/backend/calendar/src/calendar-feeds.service.ts` — `createGoogleFeeds`, `updateGoogleRefreshToken`, `getDecryptedRefreshToken`, google-aware `toDto`.
- `libs/backend/calendar/src/calendar.controller.ts` — 5 Google endpoints + `googleConfigured` in `listFeeds`.
- `libs/backend/calendar/src/calendar.module.ts` — register client, oauth service, append provider.

**Frontend — modified:**
- `apps/web/src/lib/api.ts` — Google client functions.
- `apps/web/src/pages/SettingsPage.tsx` — Connect button, picker, Reconnect button.

---

## Task 1: Contracts — Google schemas

**Files:**
- Modify: `libs/contracts/src/calendar.ts`
- Test: `libs/contracts/src/calendar.spec.ts` (create if absent; otherwise append)

**Interfaces:**
- Produces: `calendarProviderTypeSchema` now `z.enum(['ics','google'])`; `CalendarFeedsResponse` gains `googleConfigured: boolean`; new `googleAuthUrlResponseSchema`/`GoogleAuthUrlResponse`, `googlePendingResponseSchema`/`GooglePendingResponse` with `calendars: {id,summary,primary}[]`, `createGoogleFeedsRequestSchema`/`CreateGoogleFeedsRequest` `{pendingId, calendarIds: string[]}`, `googleReconnectRequestSchema`/`GoogleReconnectRequest` `{pendingId}`.

- [ ] **Step 1: Write the failing test**

Create/append `libs/contracts/src/calendar.spec.ts`:

```ts
import {
  calendarProviderTypeSchema,
  googlePendingResponseSchema,
  createGoogleFeedsRequestSchema,
  calendarFeedsResponseSchema,
} from './calendar';

describe('google calendar contracts', () => {
  it('accepts google as a provider type', () => {
    expect(calendarProviderTypeSchema.parse('google')).toBe('google');
    expect(calendarProviderTypeSchema.parse('ics')).toBe('ics');
  });

  it('parses a pending response with calendars', () => {
    const parsed = googlePendingResponseSchema.parse({
      email: 'me@corp.com',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    });
    expect(parsed.calendars[0].id).toBe('primary');
  });

  it('requires at least one calendarId when creating feeds', () => {
    expect(() => createGoogleFeedsRequestSchema.parse({ pendingId: 'x', calendarIds: [] })).toThrow();
  });

  it('exposes googleConfigured on the feeds response', () => {
    const parsed = calendarFeedsResponseSchema.parse({ feeds: [], syncRunning: false, googleConfigured: true });
    expect(parsed.googleConfigured).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/contracts/src/calendar.spec.ts` (or the repo's test runner for the contracts lib)
Expected: FAIL — `google` not in enum / schemas undefined.

- [ ] **Step 3: Implement the schema changes**

In `libs/contracts/src/calendar.ts`, change the provider enum:

```ts
/** Calendar providers. `ics` = read-only iCal feed URL; `google` = per-user OAuth. */
export const calendarProviderTypeSchema = z.enum(['ics', 'google']);
```

Add `googleConfigured` to the feeds response (replace the existing `calendarFeedsResponseSchema`):

```ts
export const calendarFeedsResponseSchema = z.object({
  feeds: z.array(calendarFeedSchema),
  syncRunning: z.boolean(),
  /** True when the server has Google OAuth env configured — gates the Connect button. */
  googleConfigured: z.boolean(),
});
export type CalendarFeedsResponse = z.infer<typeof calendarFeedsResponseSchema>;
```

Append the new Google schemas at the end of the file:

```ts
// --- Google Calendar (native OAuth) ---

export const googleAuthUrlResponseSchema = z.object({ url: z.string().url() });
export type GoogleAuthUrlResponse = z.infer<typeof googleAuthUrlResponseSchema>;

export const googleCalendarChoiceSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean(),
});
export type GoogleCalendarChoice = z.infer<typeof googleCalendarChoiceSchema>;

export const googlePendingResponseSchema = z.object({
  email: z.string(),
  calendars: z.array(googleCalendarChoiceSchema),
});
export type GooglePendingResponse = z.infer<typeof googlePendingResponseSchema>;

export const createGoogleFeedsRequestSchema = z.object({
  pendingId: z.string().min(1),
  calendarIds: z.array(z.string().min(1)).min(1),
});
export type CreateGoogleFeedsRequest = z.infer<typeof createGoogleFeedsRequestSchema>;

export const googleReconnectRequestSchema = z.object({
  pendingId: z.string().min(1),
});
export type GoogleReconnectRequest = z.infer<typeof googleReconnectRequestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/contracts/src/calendar.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/contracts/src/calendar.ts libs/contracts/src/calendar.spec.ts
git commit -m "feat(contracts): add google calendar schemas"
```

---

## Task 2: Entity columns + migration

**Files:**
- Modify: `libs/backend/persistence/src/entities/calendar-feed.entity.ts`
- Create: `libs/backend/persistence/src/migrations/1720000000007-GoogleCalendarFeeds.ts`
- Modify: `libs/backend/persistence/src/persistence.module.ts` (register the migration)

**Interfaces:**
- Produces: `CalendarFeedEntity` gains nullable `googleCalendarId`, `googleAccountEmail`, `googleRefreshTokenEncrypted: string | null`; `urlEncrypted`, `urlHash`, `urlMasked` become `string | null`.

- [ ] **Step 1: Edit the entity**

In `calendar-feed.entity.ts`, make the three `url*` columns nullable and add the Google columns. Replace the `urlEncrypted`/`urlHash`/`urlMasked` blocks with nullable versions and append the new columns after `urlMasked`:

```ts
  /**
   * ICS feed URL (secret). AES-256-GCM ciphertext `v1:<iv>:<tag>:<data>`.
   * Null for non-ICS providers (google).
   */
  @Column({ type: 'text', nullable: true })
  urlEncrypted!: string | null;

  /** sha256 hex of the normalized URL — dedupe without decrypting. Null for google. */
  @Column({ type: 'varchar', nullable: true })
  urlHash!: string | null;

  /** Safe-to-display remnant. For google feeds, a readable "email · calendar" label. */
  @Column({ type: 'varchar', nullable: true })
  urlMasked!: string | null;

  /** Google calendar id (e.g. 'primary' or '…@group.calendar.google.com'). Null for ics. */
  @Column({ type: 'varchar', nullable: true })
  googleCalendarId!: string | null;

  /** Owning Google account email — groups feeds for reconnect + dedup. Null for ics. */
  @Column({ type: 'varchar', nullable: true })
  googleAccountEmail!: string | null;

  /** OAuth refresh token (secret), AES-256-GCM encrypted like urlEncrypted. Null for ics. */
  @Column({ type: 'text', nullable: true })
  googleRefreshTokenEncrypted!: string | null;
```

- [ ] **Step 2: Write the migration**

Create `libs/backend/persistence/src/migrations/1720000000007-GoogleCalendarFeeds.ts`:

```ts
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Native Google Calendar feeds: relax the ICS-only url* columns to nullable and
 * add google-specific columns. Additive; safe on existing installs (existing
 * rows are all ICS with url* populated). The (userId, urlHash) unique index is
 * unchanged — Postgres allows multiple NULLs, so google rows (urlHash NULL) do
 * not collide.
 */
export class GoogleCalendarFeeds1720000000007 implements MigrationInterface {
  name = 'GoogleCalendarFeeds1720000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlEncrypted" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlHash" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlMasked" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleCalendarId" character varying`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleAccountEmail" character varying`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ADD "googleRefreshTokenEncrypted" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleRefreshTokenEncrypted"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleAccountEmail"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" DROP COLUMN "googleCalendarId"`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlMasked" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlHash" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "calendar_feeds" ALTER COLUMN "urlEncrypted" SET NOT NULL`);
  }
}
```

- [ ] **Step 3: Register the migration**

In `libs/backend/persistence/src/persistence.module.ts`: add the import after the `CreateCalendarTables` import and append the class to `ALL_MIGRATIONS`:

```ts
import { GoogleCalendarFeeds1720000000007 } from './migrations/1720000000007-GoogleCalendarFeeds';
```

```ts
export const ALL_MIGRATIONS = [
  InitialSchema1720000000000,
  DropAuthTables1720000000001,
  CreatePlaudSettings1720000000002,
  GeocodeCache1720000000003,
  CreateSpeakerTables1720000000004,
  InboxTombstones1720000000005,
  CreateCalendarTables1720000000006,
  GoogleCalendarFeeds1720000000007,
];
```

- [ ] **Step 4: Verify it compiles and the migration set loads**

Run: `npx tsc -p libs/backend/persistence/tsconfig.json --noEmit` (or the repo's typecheck for that lib)
Expected: no type errors. (The columns are exercised by later sqlite-backed tests.)

- [ ] **Step 5: Commit**

```bash
git add libs/backend/persistence/src/entities/calendar-feed.entity.ts libs/backend/persistence/src/migrations/1720000000007-GoogleCalendarFeeds.ts libs/backend/persistence/src/persistence.module.ts
git commit -m "feat(persistence): google calendar feed columns + migration"
```

---

## Task 3: Google Calendar API client (+ event mapping)

**Files:**
- Create: `libs/backend/calendar/src/google/google-calendar.client.ts`
- Test: `libs/backend/calendar/src/google/google-calendar.client.spec.ts`

**Interfaces:**
- Consumes: `CALENDAR_FETCH` token + `FetchLike` from `../ics/ics-feed.client`; `NormalizedCalendarEvent` from `../provider`.
- Produces:
  - `GoogleTokens = { accessToken: string; refreshToken: string | null; }`
  - `GoogleCalendarSummary = { id: string; summary: string; primary: boolean; }`
  - `class GoogleAuthError extends Error` (thrown on `invalid_grant`).
  - `class GoogleCalendarClient` with:
    - `exchangeCode(code: string): Promise<{ tokens: GoogleTokens; calendars: GoogleCalendarSummary[]; email: string }>`
    - `refreshAccessToken(refreshToken: string): Promise<string>`
    - `listEvents(accessToken: string, calendarId: string, windowStart: Date, windowEnd: Date): Promise<NormalizedCalendarEvent[]>`
    - static `mapEvent(item: unknown): NormalizedCalendarEvent | null` (exported as a module function `mapGoogleEvent` for testing)
  - Config is injected as `GoogleOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string }` via a DI token `GOOGLE_OAUTH_CONFIG`.

- [ ] **Step 1: Write the failing test**

Create `libs/backend/calendar/src/google/google-calendar.client.spec.ts`:

```ts
import { mapGoogleEvent, GoogleCalendarClient, GOOGLE_OAUTH_CONFIG } from './google-calendar.client';
import { CALENDAR_FETCH, type FetchLike } from '../ics/ics-feed.client';
import { Test } from '@nestjs/testing';

const CONFIG = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app/cb' };

describe('mapGoogleEvent', () => {
  it('maps a timed event to UTC', () => {
    const ev = mapGoogleEvent({
      id: 'abc_20260101T100000Z',
      status: 'confirmed',
      summary: 'Standup',
      description: 'daily',
      location: 'Room 1',
      start: { dateTime: '2026-01-01T11:00:00+01:00', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-01-01T11:30:00+01:00', timeZone: 'Europe/Berlin' },
    });
    expect(ev).toEqual({
      externalUid: 'abc_20260101T100000Z',
      instanceStart: '2026-01-01T10:00:00.000Z',
      startAt: '2026-01-01T10:00:00.000Z',
      endAt: '2026-01-01T10:30:00.000Z',
      isAllDay: false,
      title: 'Standup',
      description: 'daily',
      location: 'Room 1',
      timezone: 'Europe/Berlin',
    });
  });

  it('maps an all-day event to UTC midnights', () => {
    const ev = mapGoogleEvent({
      id: 'holiday1',
      status: 'confirmed',
      summary: 'Holiday',
      start: { date: '2026-01-01' },
      end: { date: '2026-01-02' },
    });
    expect(ev).toMatchObject({
      isAllDay: true,
      startAt: '2026-01-01T00:00:00.000Z',
      endAt: '2026-01-02T00:00:00.000Z',
      instanceStart: '2026-01-01T00:00:00.000Z',
      timezone: null,
    });
  });

  it('drops cancelled instances', () => {
    expect(mapGoogleEvent({ id: 'x', status: 'cancelled' })).toBeNull();
  });
});

describe('GoogleCalendarClient.listEvents', () => {
  it('follows nextPageToken and concatenates items', async () => {
    const pages: Record<string, unknown> = {
      first: { items: [{ id: 'a', status: 'confirmed', summary: 'A', start: { date: '2026-01-01' }, end: { date: '2026-01-02' } }], nextPageToken: 'p2' },
      p2: { items: [{ id: 'b', status: 'confirmed', summary: 'B', start: { date: '2026-01-03' }, end: { date: '2026-01-04' } }] },
    };
    const fetchMock: FetchLike = async (url) => {
      const token = new URL(String(url)).searchParams.get('pageToken') ?? 'first';
      return new Response(JSON.stringify(pages[token]), { status: 200 });
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        GoogleCalendarClient,
        { provide: CALENDAR_FETCH, useValue: fetchMock },
        { provide: GOOGLE_OAUTH_CONFIG, useValue: CONFIG },
      ],
    }).compile();
    const client = moduleRef.get(GoogleCalendarClient);
    const events = await client.listEvents('tok', 'primary', new Date('2026-01-01'), new Date('2026-02-01'));
    expect(events.map((e) => e.externalUid)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend/calendar/src/google/google-calendar.client.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

Create `libs/backend/calendar/src/google/google-calendar.client.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend/calendar/src/google/google-calendar.client.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add libs/backend/calendar/src/google/google-calendar.client.ts libs/backend/calendar/src/google/google-calendar.client.spec.ts
git commit -m "feat(calendar): google api client with event mapping"
```

---

## Task 4: Feeds service — Google methods + DTO

**Files:**
- Modify: `libs/backend/calendar/src/calendar-feeds.service.ts`
- Test: `libs/backend/calendar/src/calendar-feeds.service.spec.ts` (create if absent; otherwise append)

**Interfaces:**
- Consumes: `encryptSecret`/`decryptSecret` from `./crypto`; `GoogleCalendarSummary` from `./google/google-calendar.client`.
- Produces on `CalendarFeedsService`:
  - `createGoogleFeeds(input: { email: string; refreshToken: string; calendars: GoogleCalendarSummary[] }): Promise<CalendarFeedEntity[]>` — one row per calendar, skipping ones already subscribed for `(email, calendarId)`.
  - `updateGoogleRefreshToken(email: string, refreshToken: string): Promise<number>` — re-encrypts the token on every feed for that account, clears error status; returns count updated.
  - `getDecryptedRefreshToken(feed: CalendarFeedEntity): string`
  - `toDto` sets `urlMasked` from the google label for google feeds (already stored) — no signature change.

- [ ] **Step 1: Write the failing test**

Create/append `libs/backend/calendar/src/calendar-feeds.service.spec.ts`. Use the repo's existing sqlite test harness pattern for TypeORM services (mirror another `*.service.spec.ts` in this lib for module setup). The behavioral assertions:

```ts
// Assumes a `service: CalendarFeedsService` wired against sqlite with
// APP_ENCRYPTION_SECRET set in the test ConfigService (copy setup from a
// sibling calendar service spec).

it('creates one feed per selected calendar and stores an encrypted token', async () => {
  const feeds = await service.createGoogleFeeds({
    email: 'me@corp.com',
    refreshToken: 'refresh-123',
    calendars: [
      { id: 'primary', summary: 'Me', primary: true },
      { id: 'team@group.calendar.google.com', summary: 'Team', primary: false },
    ],
  });
  expect(feeds).toHaveLength(2);
  expect(feeds[0].providerType).toBe('google');
  expect(feeds[0].googleAccountEmail).toBe('me@corp.com');
  expect(feeds[0].googleRefreshTokenEncrypted).not.toContain('refresh-123'); // encrypted
  expect(service.getDecryptedRefreshToken(feeds[0])).toBe('refresh-123');
  expect(feeds[0].urlMasked).toContain('me@corp.com'); // readable label
});

it('does not duplicate an already-subscribed google calendar', async () => {
  const input = { email: 'me@corp.com', refreshToken: 'r', calendars: [{ id: 'primary', summary: 'Me', primary: true }] };
  await service.createGoogleFeeds(input);
  const second = await service.createGoogleFeeds(input);
  expect(second).toHaveLength(0);
});

it('updateGoogleRefreshToken rewrites tokens for the account and clears errors', async () => {
  const [feed] = await service.createGoogleFeeds({
    email: 'me@corp.com', refreshToken: 'old', calendars: [{ id: 'primary', summary: 'Me', primary: true }],
  });
  await service.recordSyncResult(feed.id, { status: 'error', error: 'boom' });
  const count = await service.updateGoogleRefreshToken('me@corp.com', 'new');
  expect(count).toBe(1);
  const reloaded = await service.getEntity(feed.id);
  expect(service.getDecryptedRefreshToken(reloaded)).toBe('new');
  expect(reloaded.lastSyncStatus).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend/calendar/src/calendar-feeds.service.spec.ts`
Expected: FAIL — `createGoogleFeeds` is not a function.

- [ ] **Step 3: Implement the service methods**

In `calendar-feeds.service.ts`, add the import:

```ts
import type { GoogleCalendarSummary } from './google/google-calendar.client';
```

Add these methods to the class (after `getDecryptedUrl`):

```ts
  /** Create one feed row per selected Google calendar. Skips calendars already
   *  subscribed for this account. `ponytail:` the refresh token is duplicated
   *  across rows — fine single-user; a google_connections table if multi-account. */
  async createGoogleFeeds(input: {
    email: string;
    refreshToken: string;
    calendars: GoogleCalendarSummary[];
  }): Promise<CalendarFeedEntity[]> {
    const secret = this.requireSecret();
    const encrypted = encryptSecret(input.refreshToken, secret);
    const existing = await this.repo.find({
      where: { userId: DEFAULT_USER_ID, googleAccountEmail: input.email },
    });
    const already = new Set(existing.map((f) => f.googleCalendarId));
    const created: CalendarFeedEntity[] = [];
    for (const cal of input.calendars) {
      if (already.has(cal.id)) continue;
      const feed = await this.repo.save(
        this.repo.create({
          userId: DEFAULT_USER_ID,
          name: cal.summary,
          providerType: 'google',
          urlEncrypted: null,
          urlHash: null,
          urlMasked: `${input.email} · ${cal.summary}`,
          googleCalendarId: cal.id,
          googleAccountEmail: input.email,
          googleRefreshTokenEncrypted: encrypted,
          color: null,
          enabled: true,
        }),
      );
      created.push(feed);
    }
    return created;
  }

  /** Reconnect: re-encrypt the refresh token on every feed for an account and
   *  clear any error state so the next sync retries. Returns rows updated. */
  async updateGoogleRefreshToken(email: string, refreshToken: string): Promise<number> {
    const secret = this.requireSecret();
    const encrypted = encryptSecret(refreshToken, secret);
    const feeds = await this.repo.find({
      where: { userId: DEFAULT_USER_ID, googleAccountEmail: email },
    });
    for (const feed of feeds) {
      feed.googleRefreshTokenEncrypted = encrypted;
      feed.lastSyncStatus = null;
      feed.lastSyncError = null;
      await this.repo.save(feed);
    }
    return feeds.length;
  }

  getDecryptedRefreshToken(feed: CalendarFeedEntity): string {
    if (!feed.googleRefreshTokenEncrypted) {
      throw new Error('google feed has no stored refresh token — reconnect in settings');
    }
    try {
      return decryptSecret(feed.googleRefreshTokenEncrypted, this.requireSecret());
    } catch {
      throw new Error(
        'stored google token cannot be decrypted (APP_ENCRYPTION_SECRET missing or changed) — reconnect in settings',
      );
    }
  }
```

`toDto` already returns `urlMasked` verbatim, which for google feeds is the readable label — no change needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend/calendar/src/calendar-feeds.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add libs/backend/calendar/src/calendar-feeds.service.ts libs/backend/calendar/src/calendar-feeds.service.spec.ts
git commit -m "feat(calendar): google feed create/reconnect in feeds service"
```

---

## Task 5: GoogleCalendarProvider

**Files:**
- Create: `libs/backend/calendar/src/google/google-calendar.provider.ts`
- Test: `libs/backend/calendar/src/google/google-calendar.provider.spec.ts`

**Interfaces:**
- Consumes: `GoogleCalendarClient`, `CalendarFeedsService`.
- Produces: `class GoogleCalendarProvider implements CalendarProvider` with `readonly type = 'google'`; `fetchEvents` decrypts the feed's refresh token, refreshes an access token, calls `listEvents(calendarId=feed.googleCalendarId)`. `testConnection` returns `{ ok: false, error: 'not supported for google feeds', eventCount: null, calendarName: null }` (Google feeds are validated at OAuth time, never via URL).

- [ ] **Step 1: Write the failing test**

Create `libs/backend/calendar/src/google/google-calendar.provider.spec.ts`:

```ts
import { GoogleCalendarProvider } from './google-calendar.provider';

describe('GoogleCalendarProvider', () => {
  it('refreshes a token and fetches events for the feed calendar', async () => {
    const client = {
      refreshAccessToken: jest.fn().mockResolvedValue('access-tok'),
      listEvents: jest.fn().mockResolvedValue([{ externalUid: 'e1' }]),
    };
    const feeds = { getDecryptedRefreshToken: jest.fn().mockReturnValue('refresh') };
    const provider = new GoogleCalendarProvider(client as never, feeds as never);
    const feed = { googleCalendarId: 'primary' } as never;
    const events = await provider.fetchEvents(feed, new Date('2026-01-01'), new Date('2026-02-01'));
    expect(feeds.getDecryptedRefreshToken).toHaveBeenCalledWith(feed);
    expect(client.refreshAccessToken).toHaveBeenCalledWith('refresh');
    expect(client.listEvents).toHaveBeenCalledWith('access-tok', 'primary', expect.any(Date), expect.any(Date));
    expect(events).toEqual([{ externalUid: 'e1' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend/calendar/src/google/google-calendar.provider.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the provider**

Create `libs/backend/calendar/src/google/google-calendar.provider.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend/calendar/src/google/google-calendar.provider.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/backend/calendar/src/google/google-calendar.provider.ts libs/backend/calendar/src/google/google-calendar.provider.spec.ts
git commit -m "feat(calendar): google calendar provider"
```

---

## Task 6: Google OAuth service (config gate, state, pending)

**Files:**
- Create: `libs/backend/calendar/src/google/google-oauth.service.ts`
- Test: `libs/backend/calendar/src/google/google-oauth.service.spec.ts`

**Interfaces:**
- Consumes: `ConfigService`, `GoogleCalendarClient`, `CalendarFeedsService`, `GOOGLE_OAUTH_CONFIG` value.
- Produces on `GoogleOAuthService`:
  - `isConfigured(): boolean`
  - `buildAuthUrl(): string` — random state stored (10-min TTL); returns Google consent URL (`access_type=offline`, `prompt=consent`, scope `calendar.readonly`).
  - `handleCallback(code: string, state: string): Promise<string>` — validates state, exchanges code, stores pending `{email, refreshToken, calendars}`, returns the frontend redirect URL `<appBase>/settings?googlePending=<id>`.
  - `getPending(id: string): { email: string; calendars: GoogleCalendarSummary[] }` — throws `NotFoundException` if missing/expired.
  - `confirmFeeds(pendingId: string, calendarIds: string[]): Promise<CalendarFeedEntity[]>` — resolves pending, filters chosen calendars, calls `feeds.createGoogleFeeds`, deletes pending.
  - `reconnect(pendingId: string): Promise<number>` — resolves pending, calls `feeds.updateGoogleRefreshToken(email, refreshToken)`, deletes pending.

- [ ] **Step 1: Write the failing test**

Create `libs/backend/calendar/src/google/google-oauth.service.spec.ts`:

```ts
import { GoogleOAuthService } from './google-oauth.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

function makeService(overrides?: Partial<Record<string, unknown>>) {
  const config = { clientId: 'cid', clientSecret: 'sec', redirectUri: 'https://api/cb', appBaseUrl: '' };
  const client = {
    exchangeCode: jest.fn().mockResolvedValue({
      tokens: { accessToken: 'a', refreshToken: 'r' },
      email: 'me@corp.com',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    }),
  };
  const feeds = { createGoogleFeeds: jest.fn().mockResolvedValue([{ id: 'f1' }]), updateGoogleRefreshToken: jest.fn().mockResolvedValue(2) };
  const svc = new GoogleOAuthService(config as never, client as never, feeds as never);
  return { svc, client, feeds, ...overrides };
}

describe('GoogleOAuthService', () => {
  it('rejects a callback with an unknown state', async () => {
    const { svc } = makeService();
    await expect(svc.handleCallback('code', 'bogus')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('round-trips: auth-url state -> callback -> pending -> confirm', async () => {
    const { svc, feeds } = makeService();
    const url = svc.buildAuthUrl();
    const state = new URL(url).searchParams.get('state') as string;
    const redirect = await svc.handleCallback('the-code', state);
    const pendingId = new URL(redirect, 'https://x').searchParams.get('googlePending') as string;
    const pending = svc.getPending(pendingId);
    expect(pending.email).toBe('me@corp.com');
    await svc.confirmFeeds(pendingId, ['primary']);
    expect(feeds.createGoogleFeeds).toHaveBeenCalledWith({
      email: 'me@corp.com',
      refreshToken: 'r',
      calendars: [{ id: 'primary', summary: 'Me', primary: true }],
    });
    // pending consumed
    expect(() => svc.getPending(pendingId)).toThrow(NotFoundException);
  });

  it('isConfigured is false when clientId missing', () => {
    const svc = new GoogleOAuthService({ clientId: '', clientSecret: 's', redirectUri: 'u', appBaseUrl: '' } as never, {} as never, {} as never);
    expect(svc.isConfigured()).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest libs/backend/calendar/src/google/google-oauth.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `libs/backend/calendar/src/google/google-oauth.service.ts`:

```ts
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

interface Pending {
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
  private readonly states = new Map<string, number>(); // state -> expiresAt
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

  buildAuthUrl(): string {
    this.requireConfigured();
    const state = randomBytes(16).toString('hex');
    this.states.set(state, Date.now() + TTL_MS);
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
    const expiresAt = this.states.get(state);
    this.states.delete(state);
    if (!expiresAt || expiresAt < Date.now()) {
      throw new BadRequestException('invalid or expired OAuth state');
    }
    const { tokens, calendars, email } = await this.client.exchangeCode(code);
    if (!tokens.refreshToken) {
      throw new BadRequestException(
        'Google did not return a refresh token — remove app access in your Google account and reconnect',
      );
    }
    const id = randomBytes(16).toString('hex');
    this.pending.set(id, { email, refreshToken: tokens.refreshToken, calendars, expiresAt: Date.now() + TTL_MS });
    // Relative redirect: the SPA is served same-origin behind the proxy. `ponytail:`
    // set GOOGLE_APP_BASE_URL if the SPA lives on a different origin.
    const base = this.config.appBaseUrl || '';
    return `${base}/settings?googlePending=${id}`;
  }

  getPending(id: string): { email: string; calendars: GoogleCalendarSummary[] } {
    const entry = this.resolvePending(id);
    return { email: entry.email, calendars: entry.calendars };
  }

  async confirmFeeds(pendingId: string, calendarIds: string[]): Promise<CalendarFeedEntity[]> {
    const entry = this.resolvePending(pendingId);
    const chosen = entry.calendars.filter((c) => calendarIds.includes(c.id));
    if (chosen.length === 0) throw new BadRequestException('none of the selected calendars exist in this connection');
    const feeds = await this.feeds.createGoogleFeeds({
      email: entry.email,
      refreshToken: entry.refreshToken,
      calendars: chosen,
    });
    this.pending.delete(pendingId);
    return feeds;
  }

  async reconnect(pendingId: string): Promise<number> {
    const entry = this.resolvePending(pendingId);
    const count = await this.feeds.updateGoogleRefreshToken(entry.email, entry.refreshToken);
    this.pending.delete(pendingId);
    return count;
  }

  private resolvePending(id: string): Pending {
    const entry = this.pending.get(id);
    if (!entry || entry.expiresAt < Date.now()) {
      this.pending.delete(id);
      throw new NotFoundException('this Google connection expired — start again');
    }
    return entry;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest libs/backend/calendar/src/google/google-oauth.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add libs/backend/calendar/src/google/google-oauth.service.ts libs/backend/calendar/src/google/google-oauth.service.spec.ts
git commit -m "feat(calendar): google oauth service"
```

---

## Task 7: Controller endpoints + module wiring + config

**Files:**
- Modify: `libs/backend/calendar/src/calendar.module.ts`
- Modify: `libs/backend/calendar/src/calendar.controller.ts`

**Interfaces:**
- Consumes: `GoogleOAuthService`, `GoogleCalendarClient`, `GoogleCalendarProvider`, contracts schemas from Task 1.
- Produces routes under `/v1/calendar`:
  - `GET google/auth-url` → `GoogleAuthUrlResponse`
  - `GET google/callback?code&state` → 302 redirect to the SPA
  - `GET google/pending/:id` → `GooglePendingResponse`
  - `POST google/feeds` (`CreateGoogleFeedsRequest`) → `CalendarFeedDto[]`, then fire-and-forget sync
  - `POST google/reconnect` (`GoogleReconnectRequest`) → `{ updated: number }`, then fire-and-forget sync
  - `listFeeds` response now includes `googleConfigured: this.google.isConfigured()`.

- [ ] **Step 1: Wire the module**

In `calendar.module.ts`, add imports and register the config value, client, oauth service, provider, and append the provider to `CALENDAR_PROVIDERS`. Replace the `CALENDAR_PROVIDERS` factory and add the new providers:

```ts
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GoogleCalendarClient, GOOGLE_OAUTH_CONFIG } from './google/google-calendar.client';
import { GoogleCalendarProvider } from './google/google-calendar.provider';
import { GoogleOAuthService } from './google/google-oauth.service';
```

Add to the `providers` array (alongside the ICS ones):

```ts
    {
      provide: GOOGLE_OAUTH_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        clientId: config.get<string>('GOOGLE_OAUTH_CLIENT_ID', ''),
        clientSecret: config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET', ''),
        redirectUri: config.get<string>('GOOGLE_OAUTH_REDIRECT_URI', ''),
        appBaseUrl: config.get<string>('GOOGLE_APP_BASE_URL', ''),
      }),
    },
    GoogleCalendarClient,
    GoogleCalendarProvider,
    GoogleOAuthService,
```

Change the providers factory to append Google:

```ts
    {
      provide: CALENDAR_PROVIDERS,
      useFactory: (ics: IcsCalendarProvider, google: GoogleCalendarProvider) => [ics, google],
      inject: [IcsCalendarProvider, GoogleCalendarProvider],
    },
```

- [ ] **Step 2: Add the controller endpoints**

In `calendar.controller.ts`, add imports:

```ts
import { Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  createGoogleFeedsRequestSchema,
  googleReconnectRequestSchema,
  type GoogleAuthUrlResponse,
  type GooglePendingResponse,
} from '@plaudern/contracts';
import { GoogleOAuthService } from './google/google-oauth.service';
```

Inject the service in the constructor (add parameter):

```ts
    private readonly google: GoogleOAuthService,
```

Update `listFeeds` to include the flag:

```ts
  @Get('feeds')
  async listFeeds(): Promise<CalendarFeedsResponse> {
    const feeds = await this.feeds.list();
    return {
      feeds: feeds.map((feed) => this.feeds.toDto(feed)),
      syncRunning: this.sync.isRunning,
      googleConfigured: this.google.isConfigured(),
    };
  }
```

Add the Google endpoints:

```ts
  @Get('google/auth-url')
  googleAuthUrl(): GoogleAuthUrlResponse {
    return { url: this.google.buildAuthUrl() };
  }

  @Get('google/callback')
  async googleCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    if (!code || !state) throw new BadRequestException('missing code/state');
    const redirect = await this.google.handleCallback(code, state);
    res.redirect(redirect);
  }

  @Get('google/pending/:id')
  googlePending(@Param('id') id: string): GooglePendingResponse {
    return this.google.getPending(id);
  }

  @Post('google/feeds')
  async googleCreateFeeds(@Body() body: unknown): Promise<CalendarFeedDto[]> {
    const req = createGoogleFeedsRequestSchema.parse(body);
    const feeds = await this.google.confirmFeeds(req.pendingId, req.calendarIds);
    this.fireAndForgetSync('post-google-connect');
    return feeds.map((feed) => this.feeds.toDto(feed));
  }

  @Post('google/reconnect')
  async googleReconnect(@Body() body: unknown): Promise<{ updated: number }> {
    const req = googleReconnectRequestSchema.parse(body);
    const updated = await this.google.reconnect(req.pendingId);
    this.fireAndForgetSync('post-google-reconnect');
    return { updated };
  }
```

- [ ] **Step 3: Verify the app boots and existing calendar tests pass**

Run: `npx jest libs/backend/calendar` and the API e2e/boot test if present.
Expected: PASS — DI resolves `GoogleOAuthService` (its deps `GoogleCalendarClient`, `CalendarFeedsService`, `GOOGLE_OAUTH_CONFIG` are all registered); `listFeeds` returns `googleConfigured`.

- [ ] **Step 4: Manual boot sanity (no Google env set)**

Run the API locally without Google env vars; `GET /v1/calendar/feeds` returns `"googleConfigured": false`; `GET /v1/calendar/google/auth-url` returns 400 "not configured". Existing ICS flows unaffected.

- [ ] **Step 5: Commit**

```bash
git add libs/backend/calendar/src/calendar.module.ts libs/backend/calendar/src/calendar.controller.ts
git commit -m "feat(calendar): google oauth endpoints + provider wiring"
```

---

## Task 8: Frontend API client

**Files:**
- Modify: `apps/web/src/lib/api.ts`

**Interfaces:**
- Consumes: contracts types/schemas from Task 1.
- Produces: `getGoogleAuthUrl()`, `getGooglePending(id)`, `createGoogleFeeds(pendingId, calendarIds)`, `reconnectGoogle(pendingId)`. `listCalendarFeeds` return type already includes `googleConfigured` via the updated schema.

- [ ] **Step 1: Add the client functions**

Append to `apps/web/src/lib/api.ts` (import the new schemas/types alongside the existing calendar imports):

```ts
export async function getGoogleAuthUrl(): Promise<GoogleAuthUrlResponse> {
  return googleAuthUrlResponseSchema.parse(await requestJson('/calendar/google/auth-url'));
}

export async function getGooglePending(id: string): Promise<GooglePendingResponse> {
  return googlePendingResponseSchema.parse(await requestJson(`/calendar/google/pending/${id}`));
}

export async function createGoogleFeeds(
  pendingId: string,
  calendarIds: string[],
): Promise<CalendarFeedDto[]> {
  return z
    .array(calendarFeedSchema)
    .parse(
      await requestJson('/calendar/google/feeds', {
        method: 'POST',
        body: JSON.stringify({ pendingId, calendarIds }),
      }),
    );
}

export async function reconnectGoogle(pendingId: string): Promise<{ updated: number }> {
  return (await requestJson('/calendar/google/reconnect', {
    method: 'POST',
    body: JSON.stringify({ pendingId }),
  })) as { updated: number };
}
```

Add the imports at the top (extend the existing `@plaudern/contracts` import and ensure `z` is imported — it is used by the array parse):

```ts
import { z } from 'zod';
// add to the existing contracts import:
//   calendarFeedSchema,
//   googleAuthUrlResponseSchema, type GoogleAuthUrlResponse,
//   googlePendingResponseSchema, type GooglePendingResponse,
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p apps/web/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): google calendar api client functions"
```

---

## Task 9: Frontend UI — connect, picker, reconnect

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `getGoogleAuthUrl`, `getGooglePending`, `createGoogleFeeds`, `reconnectGoogle` from Task 8; `feeds.googleConfigured`, `feed.providerType`, `feed.lastSyncStatus` from the feeds response.

- [ ] **Step 1: Connect button (gated on config)**

In `CalendarFeedsSection`, below the ICS "Add feed" block, render a Google connect button only when configured. On press, navigate the browser to the auth URL:

```tsx
const connectGoogle = async () => {
  setActionError(null);
  try {
    const { url } = await getGoogleAuthUrl();
    window.location.href = url;
  } catch (cause) {
    setActionError(cause instanceof Error ? cause.message : String(cause));
  }
};
```

```tsx
{feeds?.googleConfigured && (
  <div className="flex flex-col gap-2 border-t border-default-200 pt-4">
    <p className="text-sm text-default-500">
      Or connect a Google account directly — works when ICS export is disabled by your organization.
    </p>
    <Button variant="flat" className="self-start" onPress={connectGoogle}>
      Connect Google Calendar
    </Button>
  </div>
)}
```

- [ ] **Step 2: Calendar picker after redirect**

Read `?googlePending=<id>` on mount; if present, load the pending calendars and show a checkbox picker. On submit, call `createGoogleFeeds`, strip the query param, and refresh. Add this state + effect to `CalendarFeedsSection`:

```tsx
const [pending, setPending] = useState<GooglePendingResponse | null>(null);
const [pendingId, setPendingId] = useState<string | null>(null);
const [checked, setChecked] = useState<Set<string>>(new Set());
const [reconnectMode, setReconnectMode] = useState(false);

useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('googlePending');
  if (!id) return;
  setPendingId(id);
  setReconnectMode(params.get('reconnect') === '1');
  getGooglePending(id)
    .then((p) => {
      setPending(p);
      setChecked(new Set(p.calendars.filter((c) => c.primary).map((c) => c.id)));
    })
    .catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
}, []);

const clearPendingParam = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete('googlePending');
  url.searchParams.delete('reconnect');
  window.history.replaceState({}, '', url.toString());
};

const confirmGoogle = async () => {
  if (!pendingId) return;
  setActionError(null);
  try {
    if (reconnectMode) {
      await reconnectGoogle(pendingId);
    } else {
      await createGoogleFeeds(pendingId, [...checked]);
    }
    setPending(null);
    setPendingId(null);
    clearPendingParam();
    await refresh();
    setTimeout(() => void refresh(), 1500);
  } catch (cause) {
    setActionError(cause instanceof Error ? cause.message : String(cause));
  }
};
```

Render the picker (above the feeds list) when `pending` is set. In reconnect mode there is nothing to pick — just confirm:

```tsx
{pending && (
  <div className="flex flex-col gap-2 rounded-medium bg-default-50 p-3">
    <p className="text-sm font-medium">Connected as {pending.email}</p>
    {reconnectMode ? (
      <p className="text-sm text-default-500">Reconnect this account to resume syncing.</p>
    ) : (
      pending.calendars.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-sm">
          <Checkbox
            isSelected={checked.has(c.id)}
            onValueChange={(on) =>
              setChecked((prev) => {
                const next = new Set(prev);
                if (on) next.add(c.id);
                else next.delete(c.id);
                return next;
              })
            }
          />
          {c.summary}
        </label>
      ))
    )}
    <Button
      color="primary"
      className="self-start"
      isDisabled={!reconnectMode && checked.size === 0}
      onPress={confirmGoogle}
    >
      {reconnectMode ? 'Reconnect' : 'Add selected calendars'}
    </Button>
  </div>
)}
```

Import `Checkbox` from `@heroui/react` and the new types/functions at the top of the file.

- [ ] **Step 3: Reconnect button on errored Google feeds**

The backend redirect target is fixed (it appends only `googlePending`), so carry the reconnect intent client-side via `sessionStorage`: set it before navigating to Google, read it on return.

In the mount effect from Step 2, replace the `reconnectMode` line so it reads the marker instead of a query param:

```tsx
const isReconnect = sessionStorage.getItem('googleReconnect') === '1';
setReconnectMode(isReconnect);
sessionStorage.removeItem('googleReconnect');
```

(Also drop the `reconnect` query-param handling from Step 2's effect and `clearPendingParam` — the marker replaces it.)

In the per-feed render, add the Reconnect button:

```tsx
{feed.providerType === 'google' && feed.lastSyncStatus === 'error' && (
  <Button
    size="sm"
    variant="flat"
    color="warning"
    onPress={() => {
      sessionStorage.setItem('googleReconnect', '1');
      void connectGoogle();
    }}
  >
    Reconnect
  </Button>
)}
```

(Delete the placeholder `reconnectGoogleFeed`/`reconnectHint` sketch above — the `sessionStorage` approach is the implementation. It is kept here only to show why the marker moved client-side: the backend redirect URL is fixed.)

- [ ] **Step 4: Manual verification**

Run the web app against a backend with Google env configured. Verify: Connect button appears; consent round-trips back to `/settings?googlePending=…`; picker lists calendars; selected ones appear as feeds; disabling ICS is unaffected. With Google env unset, the Connect button is absent.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pages/SettingsPage.tsx
git commit -m "feat(web): connect google calendar + picker + reconnect"
```

---

## Task 10: Docs — Google Cloud setup + env

**Files:**
- Modify: the repo's deployment/env docs (`README.md` or `.env.example` — whichever the repo uses for env vars; grep for `APP_ENCRYPTION_SECRET` to find it).

**Interfaces:** none (documentation).

- [ ] **Step 1: Document the env vars and Google Cloud steps**

Add to the same file that documents `APP_ENCRYPTION_SECRET`:

```
# Native Google Calendar (optional). Leave unset to hide the feature.
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://your-host/v1/calendar/google/callback
# Only if the web app is served from a different origin than the API:
GOOGLE_APP_BASE_URL=
```

Add a short setup note:

```
Google Calendar setup:
1. Google Cloud Console → new/again project → enable "Google Calendar API".
2. OAuth consent screen → External → add your Google account as a Test user.
3. Credentials → Create OAuth client ID → Web application.
4. Authorized redirect URI = the exact value of GOOGLE_OAUTH_REDIRECT_URI.
5. Copy the client ID/secret into the env vars above and redeploy.
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "docs: google calendar oauth setup + env vars"
```

---

## Self-Review

**Spec coverage:**
- Per-user OAuth, read-only scope → Tasks 3, 6 (scope constant, `access_type=offline`).
- Pick-from-a-list calendar selection → Tasks 6 (`getPending`/`confirmFeeds`), 9 (picker).
- One calendar = one feed, reuse pipeline → Tasks 4, 5 (provider returns `NormalizedCalendarEvent`; sync/store/auto-link untouched).
- No new tables → Task 2 (columns on `calendar_feeds`).
- Encrypted refresh token, never in DTO → Tasks 4 (`encryptSecret`), 6 (pending never returns token), 7 (DTO carries only `urlMasked`).
- In-memory state/pending, single-instance ceiling → Task 6 (`ponytail:` comments).
- Google server-side recurring expansion (`singleEvents=true`) → Task 3.
- No new dependency → Task 3 (plain `fetch`, reuses `CALENDAR_FETCH`).
- Config gating / silent absence → Tasks 6 (`isConfigured`), 7 (`googleConfigured`), 9 (button gated).
- Reconnect flow → Tasks 4 (`updateGoogleRefreshToken`), 6 (`reconnect`), 7 (endpoint), 9 (button + sessionStorage marker).
- Google Cloud setup docs → Task 10.
- Tests: event mapping (Task 3), feed create/reconnect (Task 4), provider delegation (Task 5), oauth lifecycle (Task 6).

**Placeholder scan:** none — every code step contains concrete code. Task 9 Step 3 amends two touch-points from Step 2 (the `reconnectMode` source and `clearPendingParam`); the parenthetical calls this out explicitly.

**Type consistency:** `NormalizedCalendarEvent` shape matches the provider interface (verified against `provider.ts`). `createGoogleFeeds` input `{email, refreshToken, calendars}` is consumed identically in Task 6. `GoogleCalendarSummary`/`{id,summary,primary}` is consistent across client, service, oauth service, contracts (`googleCalendarChoiceSchema`), and UI. `GOOGLE_OAUTH_CONFIG` value shape (`clientId/clientSecret/redirectUri/appBaseUrl`) matches the module factory (Task 7) and the oauth service constructor (Task 6).

# Native Google Calendar support

## Problem

Calendars are added only via ICS/webcal feed URLs. Company Google accounts
frequently disable ICS export for security, so those users cannot subscribe.
Add native Google Calendar access via per-user OAuth so the ICS export setting
is irrelevant.

## Scope

- Per-user OAuth 2.0 (authorization code flow), **read-only** (`calendar.readonly`).
  View + auto-link only; no write-back to Google.
- After connecting an account, the user **picks which calendars** to sync from a
  list. Each picked calendar becomes one feed row in the existing feeds list.
- Reuse the existing sync → store → auto-link pipeline and the existing
  encryption helper. No new tables, no new npm dependency.

Out of scope: service-account/domain-wide delegation, multi-user, writing events
back to Google, incremental sync tokens.

## Data model

Extend `CalendarFeedEntity` / `calendar_feeds` (one Google calendar = one feed):

- `providerType` accepts `'google'` in addition to `'ics'`.
- New nullable columns:
  - `googleCalendarId` (plaintext — e.g. `primary`, `team@group.calendar.google.com`). Not secret.
  - `googleAccountEmail` (plaintext — display "Connected as …" and dedup).
  - `googleRefreshTokenEncrypted` (AES-256-GCM via the existing feeds-service helper).
- `urlEncrypted`, `urlHash`, `urlMasked` become **nullable** (ICS-only fields).

Dedup: ICS feeds keep deduping by `urlHash`; Google feeds dedup by
`(userId, googleAccountEmail, googleCalendarId)`. The `urlHash` unique index
allows multiple NULLs (Postgres default), so Google rows do not collide.

`ponytail:` the refresh token is duplicated across the calendars picked from one
account. Fine for single-user. Upgrade path: a `google_connections` table
(one row per account) with feeds referencing it — only if multi-account or
multi-user ever matters.

Migration: add the three columns, relax the three `url*` columns to nullable.
No data backfill needed (existing rows are all ICS with `url*` populated).

## OAuth flow

Scopes: `https://www.googleapis.com/auth/calendar.readonly` (covers both
`calendarList.list` and `events.list`). Auth request uses
`access_type=offline` + `prompt=consent` so a refresh token is always returned.

1. `GET /v1/calendar/google/auth-url`
   - Generates a random `state` (`crypto.randomBytes`), stored in an in-memory
     Set with a 10-minute TTL. Returns the Google consent URL.
   - `ponytail:` in-memory state store = single-instance only. The Coolify
     deployment is one container. Upgrade path: move to a short-lived DB/Redis
     key if ever horizontally scaled.
2. `GET /v1/calendar/google/callback?code=…&state=…`
   - Validates `state` against the in-memory Set (rejects unknown/expired).
   - Exchanges `code` for tokens (POST `oauth2.googleapis.com/token`).
   - Fetches the account's calendar list (`calendarList.list`). The account
     email is the `id` of the entry flagged `primary: true` (for a Google
     account the primary calendar id equals the account email) — no extra scope
     or id-token parsing needed.
   - Stashes `{ email, refreshToken, calendars: [{id, summary, primary}] }` in an
     in-memory **pending map** keyed by a fresh random id, 10-minute TTL.
   - Redirects the browser to `<frontend settings>?googlePending=<id>`.
3. `GET /v1/calendar/google/pending/:id`
   - Returns `{ email, calendars: [{id, summary, primary}] }` for the picker.
     Never returns the refresh token to the client.
4. `POST /v1/calendar/google/feeds`  body `{ pendingId, calendarIds: string[], colors?… }`
   - For each selected `calendarId`: create a `google` feed row with the
     account email, calendar id, encrypted refresh token, default name =
     calendar summary, enabled = true.
   - Triggers an immediate sync (same as adding an ICS feed).
   - Discards the pending entry.

Reconnect: a `google` feed whose token is revoked goes to `lastSyncStatus=error`.
The reconnect action re-runs steps 1–2, then calls a dedicated
`POST /v1/calendar/google/reconnect { pendingId }` which updates
`googleRefreshTokenEncrypted` on all feed rows matching
`(userId, googleAccountEmail)` instead of creating rows, and discards the
pending entry. (The account email comes from the pending entry, so the reconnect
must be for the same Google account; a mismatch is rejected.)

`GOOGLE_OAUTH_REDIRECT_URI` must exactly match the callback route registered in
Google Cloud Console.

## Sync

New `GoogleCalendarProvider implements CalendarProvider`, registered in
`CALENDAR_PROVIDERS` in `calendar.module.ts`. Selected by `feed.providerType`.

Per feed at sync time:
1. Decrypt `googleRefreshTokenEncrypted`, POST to the token endpoint to get a
   short-lived access token (never stored).
2. `GET calendar/v3/calendars/{googleCalendarId}/events` with:
   - `singleEvents=true` (Google expands recurring events server-side — no
     RRULE/Luxon expansion needed, unlike ICS),
   - `timeMin`/`timeMax` = the existing 90-days-back / 90-days-forward window,
   - `maxResults` paging via `pageToken` until exhausted (reuse the ICS
     5000-instance cap as a safety bound).
3. Map each item to the internal event shape used by the ICS provider:
   - all-day when `start.date` is present (UTC calendar-date midnights, matching
     ICS handling); timed when `start.dateTime` is present.
   - `externalUid` = Google event `id`; `instanceStart` = the instance start
     (Google returns one item per expanded occurrence, so identity is stable).
   - title/description/location/timezone mapped directly.

Everything downstream (upsert by `feedId + externalUid + instanceStart`,
auto-linking) is unchanged.

Errors: `invalid_grant` (revoked/expired refresh token) → `lastSyncStatus=error`,
`lastSyncError` = "Google authorization expired — reconnect". Other HTTP errors
are surfaced per-feed exactly like ICS fetch failures.

## Dependencies

**No new npm dependency.** Token exchange, `calendarList.list`, and
`events.list` are plain `fetch` calls, following the raw-HTTP pattern already in
`IcsFeedClient`. Deliberately avoids the heavy `googleapis` SDK.
`ponytail:` if paging/edge-cases ever get gnarly, swap in `google-auth-library`
for token handling only — not the full SDK.

## Configuration

Three env vars, read at startup:

- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI` (must equal the callback URL registered in Google Cloud)

If any is unset, the Google endpoints return a clear "not configured" error and
the frontend hides the "Connect Google Calendar" button. Feature is silently
absent when unconfigured — existing ICS behavior unaffected.

### Google Cloud Console setup (documented for the self-hoster)

1. Create/select a project → APIs & Services → enable **Google Calendar API**.
2. OAuth consent screen: External, add your Google account as a **test user**
   (keeps the app in "testing" so no verification is needed for personal use).
3. Credentials → Create OAuth client ID → **Web application**.
4. Authorized redirect URI = the value of `GOOGLE_OAUTH_REDIRECT_URI`
   (e.g. `https://plaudern.example.com/v1/calendar/google/callback`).
5. Copy client ID/secret into the three env vars.

## Frontend

In `CalendarFeedsSection` (`apps/web/src/pages/SettingsPage.tsx`):

- "Connect Google Calendar" button beside the existing ICS add-feed form.
  Hidden when the server reports Google is not configured.
- On click: `GET /v1/calendar/google/auth-url` → navigate the browser to it.
- On return with `?googlePending=<id>`: fetch the pending calendar list, show a
  checkbox picker ("Connected as x@company.com", per-calendar checkboxes with
  optional color), submit to `POST /v1/calendar/google/feeds`.
- Google feeds appear in the same feed list as ICS feeds (color, enable/disable,
  delete). A feed in `error` state shows a **Reconnect** button.

New API-client functions in `apps/web/src/lib/api.ts`:
`getGoogleAuthUrl()`, `getGooglePending(id)`, `createGoogleFeeds(pendingId, calendarIds, …)`,
and a config-availability flag (reuse an existing settings/config response, or a
tiny `googleConfigured` boolean on the feeds list response).

## Contracts

Add to `libs/contracts/src/calendar.ts`:

- `providerType` enum includes `'google'`.
- `googleAuthUrlResponseSchema` `{ url }`.
- `googlePendingResponseSchema` `{ email, calendars: [{ id, summary, primary }] }`.
- `createGoogleFeedsRequestSchema` `{ pendingId, calendarIds, colors? }`.
- Extend the feed schema so Google feeds expose `googleAccountEmail` (for the
  "Connected as …" label) and a `needsReconnect`/error indicator (reuse existing
  `lastSyncStatus`).

## Testing

`ponytail:` one runnable check for the non-trivial logic:

- Unit test: sample `events.list` JSON (one all-day `start.date` event, one timed
  `start.dateTime` event, one paged response) → asserts correct mapping to the
  internal event shape (all-day flag, UTC midnights, start/end, `externalUid`,
  `instanceStart`).
- Config-gating: with env vars unset, the Google endpoints report "not configured"
  and the feeds response marks Google unavailable.

No new test framework — use the existing backend test setup.

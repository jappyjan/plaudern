---
name: verify
description: Verify plaudern changes end-to-end — web UI changes by driving the Vite dev server with Playwright and a mocked API; backend/API changes by booting the NestJS API locally (sqlite, inline queues, no auth) and driving it over HTTP.
---

# Verifying plaudern web changes

The web app (`apps/web`, React + HeroUI + Vite) needs the NestJS API +
Postgres + MinIO to run for real, which is impractical here. Instead run the
SPA alone and mock the API at the network layer with Playwright's
`page.route` — the client is fully typed against `@plaudern/contracts`, so
mock payloads must satisfy those zod schemas.

## Recipe

1. `pnpm install --frozen-lockfile` (≈2 min cold).
2. Start the SPA only: `cd apps/web && npx vite --port 5199 --strictPort`
   (run in background). No API needed.
3. Drive with `playwright-core` (`npm i playwright-core` in a scratch dir)
   using the pre-installed Chromium at `/opt/pw-browsers/chromium`.
4. Intercept `**/api/v1/**` and fulfill:
   - `/auth/me` → `{ user: { id: <uuid>, username: '...' } }`
   - `/auth/status` → `{ usersExist: true, allowRegistration: false, authDisabled: false }`
   - `/events` (SSE) → `route.abort()` is fine for short flows
   - `/inbox?…` → `{ items: [...], nextCursor: null }`
   - Shapes live in `libs/contracts/src/inbox.ts` / `auth.ts`. All ids must
     be RFC-4122 UUIDs and all timestamps ISO datetimes or zod parsing fails
     client-side (surfaces as "Failed to load the inbox").

## Gotchas

- A "mergeable" inbox item needs `source.uploadStatus: 'committed'` and an
  `audio/*` `source.contentType`.
- Mobile layout: use viewport 390×844 with `isMobile: true, hasTouch: true`.
  The bottom tab bar only renders below the `md` breakpoint.
- Long-press = `mouse.down()`, wait >500 ms, `mouse.up()`.
- Typecheck/build if you want (`npx nx run web:typecheck`, `npx nx build web`)
  but they are not verification; there is no `web:test` target.

# Verifying plaudern API/backend changes at the HTTP surface

## Boot the API without external infra

```bash
DATABASE_DRIVER=sqlite DATABASE_URL=/tmp/verify.db \
STORAGE_DRIVER=memory QUEUE_DRIVER=inline AUTH_DISABLED=true GEOCODER=stub \
PORT=3111 node -r ts-node/register/transpile-only -r tsconfig-paths/register apps/api/src/main.ts
```

- `DATABASE_DRIVER=sqlite` + a file path gives a seedable DB (`:memory:` is default but unseedable from outside).
- `AUTH_DISABLED=true` makes every request act as `DEFAULT_USER_ID` from `@plaudern/persistence` — no passkey dance.
- Base URL: `http://127.0.0.1:$PORT/api` (`/api/health`, `/api/v1/...`). Use `curl --noproxy '*'`.
- `QUEUE_DRIVER=inline` runs extraction jobs synchronously in-process.

## Seeding

Write a `tsx` script that opens a `DataSource` (`better-sqlite3`, `entities: ALL_ENTITIES`, `synchronize: true`)
against the same file BEFORE booting the API. Items need a committed `SourcePayloadEntity`
(`uploadStatus: 'committed'`) for extractors' `appliesTo` to pass, plus succeeded
`ExtractedPayloadEntity` rows for whatever DAG dependencies the change sits behind.

## Driving LLM extractors (entities/relations/summary)

Point the provider at a local stub instead of a real endpoint:

```bash
ENTITY_EXTRACTION_ENABLED=true ENTITY_EXTRACTION_BASE_URL=http://127.0.0.1:8099/v1 ENTITY_EXTRACTION_MODEL=stub
```

The stub is a ~30-line node http server answering `POST /v1/chat/completions` with
`{ model, choices: [{ message: { content: JSON.stringify(payload) } }] }`; branch on the prompt body
to vary responses per item. Trigger runs via `POST /api/v1/extractions/backfills {"kind":"<kind>","force":true}`
and watch `GET /api/v1/extractions/backfills` for the run to complete (inline queue = near-instant).

## Gotchas

- The extractor graph is introspectable at `GET /api/v1/extractions/graph` — check your node is registered/enabled first.
- Non-forced backfills skip items whose latest succeeded row is already at the current version.
- Extraction providers default to disabled without their env keys; e2e/unit suites rely on that, so only set the enable flags for the local run.

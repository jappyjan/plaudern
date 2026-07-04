---
name: verify
description: Verify web UI changes by driving the Vite dev server with Playwright and a mocked API. Use after changing apps/web to observe the real rendered app instead of relying on typecheck/build.
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

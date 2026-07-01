# Plaudern

A modular, highly-automated **AI note-taking platform**. Its central primitive is
an **immutable Inbox** — the source of truth. Every item has a timestamp, a
source type, a raw **source payload** (audio/text/file), and optional
**extracted payloads** (transcription, OCR, …). Items are append-only and never
edited; higher-level features (auto-organization, note creation) are built on top.

This repository implements **Milestone 1**: the immutable inbox + async
transcription, plus an iOS app that pulls audio off a **Plaud** device and pushes
it into the inbox.

> Guiding principle: **Plaud is just one source adapter.** The ingestion core,
> storage, and transcription know nothing about Plaud, so the whole slice is
> verifiable without hardware via a generic audio-upload path.

## Monorepo layout (Nx + pnpm)

```
apps/
  api/           NestJS backend — the Inbox + ingestion + transcription
  mobile/        Expo (React Native) iOS app; HeroUI Native UI
    modules/plaud-sdk/   Expo native module + config plugin wrapping Plaud's XCFrameworks
libs/
  contracts/     Shared zod DTOs/types (@plaudern/contracts) — the backend↔app seam
  backend/
    persistence/ TypeORM entities + migrations
    storage/     S3/MinIO abstraction (+ in-memory fake for tests)
    inbox/        Immutable inbox aggregate + read API
    ingestion/    Source-adapter registry + presigned upload API
    transcription/ Queue (BullMQ / inline) + provider interface (Whisper / stub)
    auth/         Device API-key auth
  mobile/
    api-client/  Typed Inbox client (shares @plaudern/contracts)
    ui/          Shared RN components on HeroUI Native
docker-compose.yml   Postgres + MinIO + Redis for local dev
```

## Architecture

- **Immutable inbox** (`inbox_items`, `source_payloads`, `extracted_payloads`):
  append-only; no update/delete of source data. Reprocessing appends a new
  extraction row rather than mutating.
- **Two-phase presigned upload**: `POST /v1/ingest/init` → client PUTs bytes
  directly to S3/MinIO → `POST /v1/ingest/:id/commit`. Large audio never streams
  through Node.
- **Modular sources**: an `AdapterRegistry` keyed by source type (`audio`,
  `text`, `file`, `plaud`). Adding an input = adding one adapter.
- **Async transcription**: on commit, audio-bearing sources enqueue a job
  (BullMQ + Redis in prod, inline in tests) that streams the blob and writes back
  the transcript via a pluggable `TranscriptionProvider` (OpenAI Whisper, or a
  local stub for CI).

See `plan` details in the PR description or the architecture notes.

## Prerequisites

- Node 22, pnpm 10, Docker (for local infra)
- Xcode + an iOS device/simulator for the app (a **dev build**, not Expo Go)

## Backend — run & verify

```bash
pnpm install

# 1. Local infra (Postgres + MinIO + Redis)
docker compose up -d

# 2. Configure + run the API
cp apps/api/.env.example apps/api/.env      # defaults target the compose services
pnpm nx run api:migrate                     # apply DB schema
pnpm nx run api:seed                        # prints a device API key (x-device-key)
pnpm nx serve api                           # http://localhost:3000/api

# 3. Health check
curl http://localhost:3000/api/health
```

### Test tiers

Two complementary levels, both hardware-free:

1. **Unit / fast e2e** — in-process, sqlite + in-memory store + inline stub
   transcription. No Docker, milliseconds. Covers the full init → upload →
   commit → transcription flow:
   ```bash
   pnpm nx test api            # 6 cases incl. the full audio→transcript flow
   pnpm nx run-many -t test    # all projects
   ```

2. **Integration (Testcontainers)** — spins up **real Postgres + MinIO + Redis**
   in throwaway containers, runs the **real migration**, does a **real presigned
   S3 PUT**, and processes transcription through **real BullMQ**. Requires only a
   working Docker daemon — no manual services:
   ```bash
   pnpm nx run api:test-integration
   ```

### CI/CD

- **CI** (`.github/workflows/ci.yml`, every push/PR): typecheck → unit tests →
  **Testcontainers integration** (Docker is available on GitHub runners, so the
  entire stack is verified with zero setup) → production build. A parallel job
  typechecks the mobile app.
- **CD** (`.github/workflows/cd.yml`, push to `main` / `v*` tags): builds the API
  via the multi-stage `apps/api/Dockerfile` (tsc + tsc-alias → compiled JS) and
  pushes the image to **GHCR** (`ghcr.io/<owner>/plaudern/api`).

To drive it manually against the real stack, use the seeded API key:

```bash
KEY=<apiKey from seed>
# init
curl -sX POST localhost:3000/api/v1/ingest/init -H "x-device-key: $KEY" \
  -H 'content-type: application/json' -d '{
    "sourceType":"audio","contentType":"audio/mpeg","byteSize":12345,
    "occurredAt":"2026-07-01T09:30:00.000Z","idempotencyKey":"demo-1"}'
# PUT the file to the returned uploadUrl, then:
curl -sX POST localhost:3000/api/v1/ingest/<inboxItemId>/commit -H "x-device-key: $KEY"
curl -s localhost:3000/api/v1/inbox -H "x-device-key: $KEY"
```

## Mobile app

```bash
cp apps/mobile/.env.example apps/mobile/.env   # set EXPO_PUBLIC_API_URL to a LAN host
pnpm nx run mobile:prebuild                     # generates the iOS project (needs the native module)
pnpm nx run mobile:run-ios                      # dev build on device/simulator
```

- **Dev upload screen** (`app/dev/upload.tsx`): pick a local audio file and ingest
  it through the identical init/upload/commit path — the hardware-free demo (Path B).
- **Plaud path** (`pair.tsx` → `device/recordings.tsx`): export a recording via
  the native SDK and push it to the inbox (Path C, requires a paired device).

### Plaud native module

`apps/mobile/modules/plaud-sdk` is an Expo native module (Swift) + config plugin.
To enable it you need Plaud dev-console credentials and the Plaud XCFrameworks
(`PlaudBleSDK`, `PlaudDeviceBasicSDK`, `PlaudWiFiSDK`) linked via the podspec.
Until then the app runs against a JS simulator that returns sample devices, and
the dev-upload path remains fully functional.

## Configuration reference

Backend env: `apps/api/.env.example` (DB, S3/MinIO, Redis, transcription
provider). Key switches: `DATABASE_DRIVER` (postgres|sqlite), `STORAGE_DRIVER`
(s3|memory), `QUEUE_DRIVER` (bull|inline), `TRANSCRIPTION_PROVIDER` (stub|openai).

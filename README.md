# Plaudern

A modular, highly-automated **AI note-taking platform**. Its central primitive is
an **immutable Inbox** — the source of truth. Every item has a timestamp, a
source type, a raw **source payload** (audio/text/file), and optional
**extracted payloads** (transcription, OCR, …). Items are append-only and never
edited; higher-level features (auto-organization, note creation) are built on top.

This repository implements the immutable inbox + async transcription, plus a
**web app** for capturing recordings: upload audio files or record directly in
the browser. Web first — a mobile app comes later.

> Guiding principle: **every input is just a source adapter.** The ingestion
> core, storage, and transcription know nothing about where audio comes from,
> so the whole slice is verifiable via a generic audio-upload path.

> ⚠️ **No auth.** Plaudern is designed to be self-hosted **per user** and the
> API/web app are completely unprotected. If you expose them beyond localhost,
> put your own access control in front (reverse-proxy basic auth, Tailscale,
> VPN, …).

## Monorepo layout (Nx + pnpm)

```
apps/
  api/           NestJS backend — the Inbox + ingestion + transcription
  web/           Vite + React SPA (HeroUI + Tailwind) — upload & record UI
  speaker-id-ml/ Python ML sidecar (FastAPI) — pyannote diarization + faster-whisper transcription
libs/
  contracts/     Shared zod DTOs/types (@plaudern/contracts) — the backend↔frontend seam
  backend/
    persistence/ TypeORM entities + migrations
    storage/     S3/MinIO abstraction (+ in-memory fake for tests)
    inbox/        Immutable inbox aggregate + read API
    ingestion/    Source-adapter registry + presigned upload API
    transcription/ Queue (BullMQ / inline) + provider interface (sidecar whisper / OpenAI)
    speaker-id/   Diarization queue + voice-profile matching + contact book API
docker-compose.yml   Postgres + MinIO + Redis (+ api + web + speaker-id) for local dev
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
  (BullMQ + Redis in prod, inline in tests) that writes back the transcript via
  a pluggable `TranscriptionProvider` — the self-hosted faster-whisper in the
  `apps/speaker-id-ml` sidecar by default, or the OpenAI Whisper API
  (`TRANSCRIPTION_PROVIDER=openai`). Tests override the provider with jest
  fakes.
- **Speaker identification**: alongside transcription, audio enqueues a
  diarization job against a pluggable `DiarizationProvider` (the self-hosted
  pyannote sidecar in `apps/speaker-id-ml`). Detected voices
  are matched by embedding similarity to persistent **voice profiles**, so the
  same person is recognized across recordings; unknown voices land in a review
  queue in the web app's contact book (`/contacts`), where they can be named,
  confirmed, or merged. The transcript view renders speaker-attributed segments
  by aligning transcript segment timestamps with the diarization at read
  time. The pyannote models are gated on Hugging Face — see
  `apps/speaker-id-ml/README.md` for the one-time `HF_TOKEN` setup (required
  for a default deploy).
- **Capture metadata travels with the item**: `occurredAt` (when it was
  recorded) plus a free-form `metadata` field (GPS location, recording device,
  file tags) set at ingest time — the envelope is immutable, so metadata is
  extracted client-side *before* `init`. Uploaded files get their metadata from
  their own embedded tags (ID3 / MP4-QuickTime atoms / Vorbis comments);
  in-browser recordings use the recording start time, the browser geolocation
  (if granted), and the user agent.

## Prerequisites

- Node 22, pnpm 10, Docker (for local infra)

## Run & verify

**Whole stack in Docker** (web + API + ML sidecar + Postgres + MinIO + Redis).
Migrations run automatically on boot. Set `HF_TOKEN` first (see
`apps/speaker-id-ml/README.md`) — the sidecar handles transcription and
diarization by default and downloads ~1.5 GB of models on first start:

```bash
HF_TOKEN=hf_... docker compose up -d --build
open http://localhost:8080          # web app (nginx, proxies /api to the api)
curl http://localhost:3000/api/health
```

**Infra in Docker, api + web from source** (fast iteration):

```bash
pnpm install
HF_TOKEN=hf_... docker compose up -d postgres minio minio-init redis speaker-id   # infra + ML sidecar
cp apps/api/.env.example apps/api/.env
pnpm nx run api:migrate                     # apply DB schema
pnpm nx serve api                           # http://localhost:3000/api
pnpm nx serve web                           # http://localhost:5173 (proxies /api)
```

> **Presigned URLs & `S3_PUBLIC_ENDPOINT`:** the API signs upload/download URLs
> against `S3_PUBLIC_ENDPOINT` (falling back to `S3_ENDPOINT`). Server-side S3
> calls use the internal `S3_ENDPOINT` (`http://minio:9000`), but the URL handed
> to a client must be reachable from *that client*. To upload from another
> device, set `S3_PUBLIC_ENDPOINT` to your machine's LAN IP, e.g.
> `S3_PUBLIC_ENDPOINT=http://192.168.1.100:9000 docker compose up -d`.

> **Microphone & HTTPS:** in-browser recording (`getUserMedia`) requires a
> secure context. `http://localhost` works; a plain-http LAN IP does not — use
> HTTPS (or a tunnel) to record from other devices. File upload works anywhere.

## Web app

- **Upload**: pick audio files; recording time, GPS location, recording device,
  and common tags are extracted from the file's embedded metadata
  (`music-metadata` in the browser) and stored on the inbox item. Falls back to
  the file's modification time when untagged. The browser's own location is
  deliberately *not* attached to uploads.
- **Record**: in-browser `MediaRecorder` (webm/opus on Chrome/Firefox, mp4 on
  Safari). `occurredAt` = recording start; browser geolocation (if you grant
  it) and user agent land in `metadata`.
- **Inbox**: newest-first list with transcription status; item detail plays the
  audio via a presigned URL, polls the transcription until it lands, and shows
  the capture metadata (time, location with an OpenStreetMap link, device,
  tags).

### Test tiers

Two complementary levels:

1. **Unit / fast e2e** — in-process, sqlite + in-memory store + inline queues
   with jest-faked transcription/diarization providers. No Docker,
   milliseconds. Covers the full init → upload → commit → transcription flow:
   ```bash
   pnpm nx test api            # incl. the full audio→transcript flow
   pnpm nx run-many -t test    # all projects
   ```

2. **Integration (Testcontainers)** — spins up **real Postgres + MinIO + Redis**
   in throwaway containers, runs the **real migrations**, does a **real presigned
   S3 PUT**, and processes transcription through **real BullMQ**. Requires only a
   working Docker daemon — no manual services:
   ```bash
   pnpm nx run api:test-integration
   ```

### CI/CD

- **CI** (`.github/workflows/ci.yml`, every push/PR): backend job — typecheck →
  unit tests → **Testcontainers integration** (Docker is available on GitHub
  runners, so the entire stack is verified with zero setup) → production build.
  A parallel job typechecks and builds the web app.
- **CD** (`.github/workflows/cd.yml`, push to `main` / `v*` tags): builds the
  `api`, `web`, and `speaker-id-ml` images from their Dockerfiles and pushes
  them to **GHCR** (`ghcr.io/<owner>/plaudern/{api,web,speaker-id-ml}`).

## Deploy to Coolify

`docker-compose.coolify.yaml` is a self-contained stack (web + API + Postgres +
MinIO + Redis) using Coolify's magic environment variables:

- `SERVICE_FQDN_WEB_80` / `SERVICE_FQDN_API_3000` / `SERVICE_FQDN_MINIO_9000` —
  Coolify provisions a domain + TLS and routes it to the container port. The
  API's presigned URLs are signed against the public MinIO FQDN, so uploads
  work from any client, and the web domain serves the SPA (its nginx proxies
  `/api` internally).
- `SERVICE_USER_*` / `SERVICE_PASSWORD_*` — Postgres, MinIO, and Redis
  credentials are generated and persisted automatically on first deploy.

Steps: create a **Docker Compose** resource in Coolify pointing at this repo,
set the compose file to `docker-compose.coolify.yaml`, and set `HF_TOKEN` in
the UI (**required** — the ML sidecar handles transcription and diarization by
default; see `apps/speaker-id-ml/README.md` for the one-time token setup).
Optionally set `OPENAI_API_KEY` + `TRANSCRIPTION_PROVIDER=openai` to use the
OpenAI Whisper API for transcription instead — providers are fixed at container
boot, so changing them means editing the env vars and redeploying. Deploy —
migrations run on boot. Remember: **no auth** — restrict access to the exposed
domains yourself.

To drive the API manually:

```bash
# init
curl -sX POST localhost:3000/api/v1/ingest/init \
  -H 'content-type: application/json' -d '{
    "sourceType":"audio","contentType":"audio/mpeg","byteSize":12345,
    "occurredAt":"2026-07-01T09:30:00.000Z","idempotencyKey":"demo-1",
    "metadata":{"location":{"lat":52.52,"lon":13.405}}}'
# PUT the file to the returned uploadUrl, then:
curl -sX POST localhost:3000/api/v1/ingest/<inboxItemId>/commit
curl -s localhost:3000/api/v1/inbox
```

## Configuration reference

Backend env: `apps/api/.env.example` (DB, S3/MinIO, Redis, transcription
provider). Key switches: `DATABASE_DRIVER` (postgres|sqlite), `STORAGE_DRIVER`
(s3|memory), `QUEUE_DRIVER` (bull|inline), `TRANSCRIPTION_PROVIDER`
(sidecar|openai), `SPEAKER_ID_PROVIDER` (pyannote|off).

# Plaudern

A modular, highly-automated **AI note-taking platform**. Its central primitive is
the **Inbox** — the source of truth. Every item has a timestamp, a
source type, a raw **source payload** (audio/text/file), and optional
**extracted payloads** (transcription, OCR, …). Items are never edited in
place — they can only be deleted whole — and higher-level features
(auto-organization, note creation) are built on top.

This repository implements the inbox + async transcription, plus a
**web app** for capturing recordings: upload audio files or record directly in
the browser. Web first — a mobile app comes later.

> Guiding principle: **every input is just a source adapter.** The ingestion
> core, storage, and transcription know nothing about where audio comes from,
> so the whole slice is verifiable via a generic audio-upload path.

> 🔐 **Multi-user, passkey-only auth.** Plaudern supports multiple accounts on
> one instance, each secured by **passkeys (WebAuthn)** — there are no
> passwords. Every account is **fully isolated**: inbox items, blobs,
> transcripts, voice profiles/contacts, calendar feeds & events, links and
> Plaud settings are all scoped to their owner; nothing is shared between
> users. The first account to register **adopts all data** created while the
> instance ran unauthenticated. Registration is open by default (set
> `AUTH_ALLOW_REGISTRATION=false` to lock it after signing up); set
> `AUTH_DISABLED=true` to restore the old unauthenticated single-user mode.
> Passkeys are bound to the serving domain — set `AUTH_RP_ID` (and, when
> needed, `AUTH_ORIGINS`) when deploying beyond localhost. Note that WebAuthn
> requires a secure context: `localhost` or HTTPS.

## Monorepo layout (Nx + pnpm)

```
apps/
  api/           NestJS backend — the Inbox + ingestion + transcription
  web/           Vite + React SPA (HeroUI + Tailwind) — upload & record UI
libs/
  contracts/     Shared zod DTOs/types (@plaudern/contracts) — the backend↔frontend seam
  backend/
    persistence/ TypeORM entities + migrations
    storage/     S3/MinIO abstraction (+ in-memory fake for tests)
    queue/       Generic BullMQ / inline job-queue abstraction
    inbox/        Inbox aggregate + read/delete API
    ingestion/    Source-adapter registry + presigned upload API
    transcription/ Transcription queue + ElevenLabs Scribe / local Whisper providers
    speaker-id/   Diarization queue + voice-profile matching + contact book API
    summarization/ AI title + Markdown summary (OpenAI-compatible LLM: DeepSeek by default, or local Ollama)
    email-ingest/ Email-in adapter — per-user inbox+<token>@<domain> address + inbound webhook
docker-compose.yml   Postgres + MinIO + Redis + api + web for local dev
```

## Architecture

- **Never-edited inbox** (`inbox_items`, `source_payloads`, `extracted_payloads`):
  no in-place updates of source data — reprocessing appends a new extraction row
  rather than mutating. Items can be deleted whole (rows + blobs); a tombstone
  of the idempotency key (`inbox_tombstones`) keeps automated syncs (Plaud,
  email-in) from re-importing deleted items.
- **Two-phase presigned upload**: `POST /v1/ingest/init` → client PUTs bytes
  directly to S3/MinIO → `POST /v1/ingest/:id/commit`. Large audio never streams
  through Node.
- **Modular sources**: an `AdapterRegistry` keyed by source type (`audio`,
  `text`, `file`, `plaud`, `email`). Adding an input = adding one adapter.
- **Email-in** (`sources/email`): every user gets a personal
  `inbox+<token>@<domain>` address (generate/rotate it from Settings). An
  inbound-parse webhook (`POST /v1/webhooks/email`, guarded by
  `EMAIL_WEBHOOK_SECRET`) accepts either a raw MIME body or a SendGrid/SES-style
  JSON wrapper, parses it with `mailparser`, and turns one email into one inbox
  item — subject/text as the payload, `occurredAt` from the `Date` header,
  attachments stored via the storage abstraction, idempotent on `Message-ID`.
- **Async transcription**: on commit, audio-bearing sources enqueue a job
  (BullMQ + Redis in prod, inline in tests) that transcribes via the hosted
  [ElevenLabs Scribe](https://elevenlabs.io) API (`ELEVENLABS_API_KEY`, the
  default; audio bytes are pushed to ElevenLabs directly, so storage stays
  private) or a **self-hosted Whisper-compatible server**
  (`TRANSCRIPTION_PROVIDER=whisper` + `WHISPER_BASE_URL` — any server exposing
  the OpenAI `/v1/audio/transcriptions` contract, e.g.
  [faster-whisper-server/speaches](https://github.com/speaches-ai/speaches) or
  whisper.cpp's server; no model weights ship with this app). The local tier
  keeps audio fully off the network — required for sensitivity-routed content
  that must never leave the box. Tests override the provider with jest fakes.
- **Speaker identification**: alongside transcription, audio enqueues a
  diarization job handled by the hosted [pyannoteAI](https://pyannote.ai) API
  (`PYANNOTEAI_API_KEY`; set `SPEAKER_ID_PROVIDER=off` to disable). Speakers
  are matched across recordings via voiceprints: known voices are identified
  server-side (`/identify`), and new speakers with enough clean speech are
  auto-enrolled from clips sliced in-process with ffmpeg. Detected voices link
  to persistent **voice profiles**; unknown voices land in a review queue in
  the web app's contact book (`/contacts`), where they can be named, confirmed,
  or merged. The transcript view renders speaker-attributed segments by
  aligning transcript segment timestamps with the diarization at read time.
- **AI summarization**: once a recording is transcribed and diarized, the next
  pipeline step (`libs/backend/summarization`) hands the speaker-attributed
  transcript to an LLM that writes a short descriptive **title** and a
  **Markdown summary**, picking a layout that fits the content (meeting,
  interview, lecture, to-dos, note, …). The summary supports **mermaid
  diagrams** and mentions speakers with `@[LABEL]` tokens that the web app turns
  into the same clickable speaker chips as the transcript. It runs as another
  append-only extraction (`kind: summary`), triggered in-process when the
  transcription/diarization finish, so job ordering never matters and a
  reprocess regenerates it. The **summary language** is a per-user setting
  (Settings → AI summaries): `Automatic` follows each recording's spoken
  language, or pick a fixed language applied to every future summary. Any
  **OpenAI-compatible** `/chat/completions` endpoint works — the default
  targets **DeepSeek** (`deepseek-chat`), the cheapest capable option; leave
  `SUMMARIZATION_API_KEY` empty to disable the step (the UI then just shows the
  transcript). A **local Ollama** server works the same way — Ollama needs no
  API key, so set `SUMMARIZATION_ENABLED=true` instead and point
  `SUMMARIZATION_BASE_URL`/`SUMMARIZATION_MODEL` at it (e.g.
  `http://localhost:11434/v1` / `llama3.1`) for a fully local summarization
  path. Detail pages show the summary and transcript in a **tabbed view**,
  defaulting to the summary once it's ready.
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

**Whole stack in Docker** (web + API + Postgres + MinIO + Redis). Migrations
run automatically on boot. Transcription and diarization run on hosted APIs —
set `ELEVENLABS_API_KEY` and `PYANNOTEAI_API_KEY` (without keys the stack still
runs; those extraction jobs just fail with a clear error):

```bash
ELEVENLABS_API_KEY=... PYANNOTEAI_API_KEY=... docker compose up -d --build
open http://localhost:8080          # web app (nginx, proxies /api to the api)
curl http://localhost:3000/api/health
```

**Fully local model tier** (no cloud AI at all — see `docker-compose.yml`'s
commented `whisper`/`ollama` services): uncomment those two services, then set
`TRANSCRIPTION_PROVIDER=whisper`, `SUMMARIZATION_ENABLED=true`,
`SUMMARIZATION_BASE_URL=http://ollama:11434/v1`, and `SUMMARIZATION_MODEL` to
a model you've pulled (`docker compose exec ollama ollama pull llama3.1`), then
`docker compose up -d --build`. Speaker diarization still needs
`PYANNOTEAI_API_KEY` today — see ATT-687 for local-only routing across all
three stages.

**Infra in Docker, api + web from source** (fast iteration):

```bash
pnpm install
docker compose up -d postgres minio minio-init redis   # infra only
cp apps/api/.env.example apps/api/.env      # fill in the API keys
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
- **Inbox**: newest-first list with transcription status (and the AI title once
  summarized); item detail plays the audio via a presigned URL, polls the
  transcription until it lands, and shows the capture metadata (time, location
  with an OpenStreetMap link, device, tags). The transcript and AI **summary**
  live in a tabbed view (Markdown + mermaid, clickable speaker mentions),
  defaulting to the summary when one exists.
- **Calendar**: subscribe to iCal/ICS feed URLs (Google Calendar's "secret
  address", Outlook, iCloud, …) in settings — the URL is a secret and is
  stored AES-encrypted. A month view shows events and recordings per day;
  recordings that happened during an event are **auto-linked** to it
  (`occurredAt` + duration overlap, re-evaluated on every feed sync). Clicking
  an event lists its recordings; an item's detail page lists its events. Links
  can also be added/removed manually — a manual unlink is remembered and never
  resurrected by a later sync. Feeds refresh every 15 min
  (`CALENDAR_POLL_INTERVAL_MS`), window: ±90 days.

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
  `api` and `web` images from their Dockerfiles and pushes them to **GHCR**
  (`ghcr.io/<owner>/plaudern/{api,web}`).

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
set the compose file to `docker-compose.coolify.yaml`, and fill in
`ELEVENLABS_API_KEY` (transcription) and `PYANNOTEAI_API_KEY` (diarization) in
the UI. Passkeys
bind to the web app's domain: `AUTH_RP_ID` defaults to `SERVICE_FQDN_WEB` (the
domain Coolify assigned to the web service), so it auto-populates; override it
only for custom setups, and remember that changing the domain later invalidates
already-registered passkeys (inherent to WebAuthn). Deploy — migrations run on
boot, then open the web app and register the first account (it becomes the
owner of any pre-existing data).

To drive the API manually (the curl examples assume `AUTH_DISABLED=true`;
with auth enabled, sign in via the web app or send the `plaudern_session`
cookie):

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

Backend env: `apps/api/.env.example` (DB, S3/MinIO, Redis, hosted-API keys).
Key switches: `DATABASE_DRIVER` (postgres|sqlite), `STORAGE_DRIVER`
(s3|memory), `QUEUE_DRIVER` (bull|inline), `SPEAKER_ID_PROVIDER`
(pyannoteai|off; `pyannoteai` needs `PYANNOTEAI_API_KEY`),
`TRANSCRIPTION_PROVIDER` (elevenlabs|whisper; `elevenlabs` needs
`ELEVENLABS_API_KEY`, `whisper` needs `WHISPER_BASE_URL` pointing at a
self-hosted Whisper-compatible server — the local-model tier), and
`SUMMARIZATION_API_KEY` (enables AI summaries; with
`SUMMARIZATION_BASE_URL`/`SUMMARIZATION_MODEL` pointing at any
OpenAI-compatible endpoint, DeepSeek by default — or `SUMMARIZATION_ENABLED=true`
instead of a key for keyless local endpoints like Ollama), `EMAIL_INBOUND_DOMAIN` +
`EMAIL_WEBHOOK_SECRET` (email-in adapter; point your inbound mail relay's
webhook at `/api/v1/webhooks/email` with that secret).

Authentication env: `AUTH_RP_ID` (WebAuthn relying-party id = the domain the
web app is served from; default `localhost`), `AUTH_ORIGINS` (comma-separated
origins accepted in ceremonies and CORS; defaults to the localhost dev ports,
or `https://<AUTH_RP_ID>` for a real domain), `AUTH_SESSION_TTL_DAYS` (session
cookie lifetime, default 30), `AUTH_ALLOW_REGISTRATION` (default `true`; the
first account can always be created), `AUTH_DISABLED` (default `false`; `true`
restores the old unauthenticated single-user mode).

# @plaudern/ai-config

Per-user AI configuration, stored in the database — **not** environment variables.

> [!IMPORTANT]
> **For future developers & agents:** do **NOT** add new `<CAPABILITY>_API_KEY` /
> `_BASE_URL` / `_MODEL` / `_TIMEOUT_MS` / `_ENABLED` environment variables for AI
> features. AI provider credentials and per-capability settings now live in the
> database and are managed per user in **Settings → AI**. To add a new AI
> capability, follow the pattern below.

## The model

AI config is split into two concepts:

1. **Providers** (`ai_providers` table) — reusable *connections* / credentials a
   user adds once: `{ name, protocol, baseUrl, apiKey }`. One DeepSeek key is one
   connection, reused by many capabilities. The API key is encrypted at rest
   (`APP_ENCRYPTION_SECRET`, via `secret-crypto.ts`) and never returned in
   plaintext.
2. **Capabilities** (`ai_capability_settings` table) — for each capability
   (summarization, ocr, transcription, …) the user picks *which provider* powers
   it, plus a model, timeout and capability-specific params. One row per
   `(user, capability)`.

A capability with no row, no assigned provider, or `enabled = false` is **off** —
its pipeline step no-ops, exactly as an empty `*_API_KEY` used to.

## Using it in a provider

Providers no longer read `ConfigService`. They inject `AiConfigService` and
resolve per request (the `userId` is always available — `item.userId` in
processors, `userId` args in services):

```ts
const config = await this.aiConfig.resolve(userId, 'summarization');
if (!config) throw new Error('summarization is not configured (Settings → AI)');
const res = await this.chatClient.chat(config, { messages, temperature: 0.3 });
```

For OpenAI-compatible chat/vision use `OpenAiChatClient`; for embeddings use
`OpenAiEmbeddingsClient`. Non-OpenAI protocols (ElevenLabs, Whisper, pyannoteAI)
read the same `ResolvedAiConfig` but keep their own HTTP logic.

Enablement is per-user and async: `Extractor.enabled(userId)` delegates to
`AiConfigService.isEnabled(userId, capability)`.

## Adding a new capability

1. Add its id to `aiCapabilitySchema` in `libs/contracts/src/ai-capabilities.ts`.
2. Add a `CapabilityMeta` entry in `capability-registry.ts` (kind, defaults,
   params, optional `inheritsFrom`, and — only if it needs upgrade import — a
   `legacyEnvPrefix`).
3. Point the capability's provider class at
   `AiConfigService.resolve(userId, '<capability>')`.

## Upgrade import

`AiConfigImportService` runs once at boot: if the pre-auth owner
(`DEFAULT_USER_ID`) has no providers yet, it reads the legacy AI env vars and
seeds provider connections + capability rows so existing deployments keep
working. The first registered user adopts these rows. Fresh installs (no AI env)
seed nothing.

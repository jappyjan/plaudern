# @plaudern/ai-config

Per-user AI configuration, stored in the database — **not** environment variables.

> [!IMPORTANT]
> **For future developers & agents:** do **NOT** add new `<CAPABILITY>_API_KEY` /
> `_BASE_URL` / `_MODEL` / `_TIMEOUT_MS` / `_ENABLED` environment variables for AI
> features. AI provider credentials and per-capability settings now live in the
> database and are managed per user in **Settings → AI**. To add a new AI
> capability, follow the pattern below.

## The model

AI config is split into three concepts:

1. **Providers** (`ai_providers` table) — reusable *connections* / credentials a
   user adds once: `{ name, protocol, baseUrl, preset, apiKey }`. One DeepSeek key
   is one connection, reused by many capabilities. `preset` records the vendor it
   was created from (`deepseek`, `openai`, …) so the UI can prefill the base URL
   and suggest models (see `ai-provider-presets.ts` in contracts). The API key is
   encrypted at rest (`APP_ENCRYPTION_SECRET`, via `secret-crypto.ts`) and never
   returned in plaintext.
2. **Capability groups** (`ai_capability_group_settings` table) — the primary,
   *simplified* surface. One **shared** setting per capability *kind* (chat,
   vision, embeddings, stt, diarization): `{ providerId, model, timeoutMs, params,
   enabled }`, one row per `(user, kind)`. Configuring "Reasoning & Chat" once
   powers all ~18 chat capabilities.
3. **Per-task overrides** (`ai_capability_settings` table) — sparse: a row exists
   only when the user overrides one capability away from its group (the Advanced
   view). Each field layers independently.

**Resolution** (`AiConfigService.resolve`) layers, per field:
`per-task override ?? shared group ?? registry default`. A capability is **off**
when its group is disabled, its override is disabled, or nothing resolves to a
usable provider + model — its pipeline step no-ops, exactly as an empty
`*_API_KEY` used to. Opt-in capabilities (`web_research`) stay off until the user
enables them explicitly in Advanced. "Reset" (`DELETE
settings/ai/capability-groups/:kind/overrides`) drops every override so members
fall back to the shared group.

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
2. Add a `CapabilityMeta` entry in `capability-registry.ts` with the right
   `kind` (it automatically joins that kind's group), defaults, params, and —
   only if it needs upgrade import — a `legacyEnvPrefix`.
3. Point the capability's provider class at
   `AiConfigService.resolve(userId, '<capability>')`.

The five groups are derived from `kind` in `capability-registry.ts`
(`capabilityGroups()` / `GROUP_DEFS`); a new capability needs no group wiring.

## Upgrade import

`AiConfigImportService` runs once at boot: if the pre-auth owner
(`DEFAULT_USER_ID`) has no providers yet, it reads the legacy AI env vars, seeds
provider connections, then **collapses** them into the shared group settings
(keeping only genuinely divergent tasks as overrides) so existing deployments
keep working. The `1720000000048-SimplifyAiConfig` migration performs the same
collapse for rows written under the old per-capability model. The first
registered user adopts these rows. Fresh installs (no AI env) seed nothing.

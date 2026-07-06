import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AiCapability, AiProviderProtocol } from '@plaudern/contracts';
import {
  AiCapabilitySettingEntity,
  AiProviderEntity,
  DEFAULT_USER_ID,
  encryptSecret,
} from '@plaudern/persistence';
import { ALL_CAPABILITIES, capabilityMeta } from './capability-registry';

interface DesiredProvider {
  protocol: AiProviderProtocol;
  baseUrl: string;
  apiKey: string | null;
}

interface DesiredCapability {
  capability: AiCapability;
  provider: DesiredProvider;
  model: string | null;
  timeoutMs: number | null;
  params: Record<string, unknown>;
  enabled: boolean;
}

/**
 * One-time, idempotent upgrade path: on boot, if the pre-auth owner
 * (DEFAULT_USER_ID) has no AI providers yet, read the *legacy* AI env vars and
 * seed provider connections + capability rows so existing deployments keep
 * working after AI config moved from env to the DB. The first registered user
 * adopts these rows (AuthService.adoptPreAuthData), exactly like other pre-auth
 * data.
 *
 * Fresh installs (no AI env set) seed nothing — the user configures everything
 * in Settings → AI. This runs in the API process (which reliably has all env),
 * not in a migration.
 */
@Injectable()
export class AiConfigImportService implements OnModuleInit {
  private readonly logger = new Logger(AiConfigImportService.name);
  private readonly encryptionSecret: string;

  constructor(
    @InjectRepository(AiProviderEntity)
    private readonly providers: Repository<AiProviderEntity>,
    @InjectRepository(AiCapabilitySettingEntity)
    private readonly capabilities: Repository<AiCapabilitySettingEntity>,
    private readonly config: ConfigService,
  ) {
    this.encryptionSecret = config.get<string>('APP_ENCRYPTION_SECRET', 'change-me');
  }

  async onModuleInit(): Promise<void> {
    const existing = await this.providers.count({ where: { userId: DEFAULT_USER_ID } });
    if (existing > 0) return; // already imported (or configured) — idempotent no-op

    const desired = this.collectDesired();
    if (desired.length === 0) {
      this.logger.log('no legacy AI env detected — nothing to import (fresh install)');
      return;
    }

    // De-duplicate provider connections so one shared key becomes one row.
    const providerByKey = new Map<string, AiProviderEntity>();
    const usedNames = new Set<string>();
    for (const item of desired) {
      const key = providerKey(item.provider);
      if (providerByKey.has(key)) continue;
      const name = uniqueName(providerName(item.provider), usedNames);
      usedNames.add(name);
      const entity = this.providers.create({
        userId: DEFAULT_USER_ID,
        name,
        protocol: item.provider.protocol,
        baseUrl: item.provider.baseUrl,
        apiKeyEncrypted: item.provider.apiKey
          ? encryptSecret(item.provider.apiKey, this.encryptionSecret)
          : null,
      });
      providerByKey.set(key, await this.providers.save(entity));
    }

    for (const item of desired) {
      const provider = providerByKey.get(providerKey(item.provider));
      if (!provider) continue;
      await this.capabilities.save(
        this.capabilities.create({
          userId: DEFAULT_USER_ID,
          capability: item.capability,
          providerId: provider.id,
          model: item.model,
          timeoutMs: item.timeoutMs,
          enabled: item.enabled,
          params: Object.keys(item.params).length > 0 ? item.params : null,
        }),
      );
    }

    this.logger.log(
      `imported ${providerByKey.size} AI provider(s) and ${desired.length} capability setting(s) from legacy env`,
    );
  }

  private collectDesired(): DesiredCapability[] {
    const out: DesiredCapability[] = [];
    for (const capability of ALL_CAPABILITIES) {
      const item =
        capability === 'transcription'
          ? this.transcription()
          : capability === 'speaker_id'
            ? this.speakerId()
            : this.openAiCapability(capability);
      if (item) out.push(item);
    }
    return out;
  }

  /** Generic `<PREFIX>_{API_KEY,BASE_URL,MODEL,TIMEOUT_MS,ENABLED}` importer. */
  private openAiCapability(capability: AiCapability): DesiredCapability | null {
    const meta = capabilityMeta(capability);
    const prefix = meta.legacyEnvPrefix;
    if (!prefix) return null; // inherits — covered by its parent's import + resolver

    const apiKey = this.env(`${prefix}_API_KEY`);
    const baseUrl = this.env(`${prefix}_BASE_URL`);
    const model = this.env(`${prefix}_MODEL`);
    const timeoutMs = this.envNumber(`${prefix}_TIMEOUT_MS`);
    const enabledFlag = this.env(`${prefix}_ENABLED`) === 'true';

    // Was this capability configured independently in env? (own key, own
    // keyless-enable flag, or an explicit base URL). If not, skip — inheritance
    // and/or "unconfigured" cover it.
    const configured = apiKey.length > 0 || enabledFlag || baseUrl.length > 0;
    if (!configured) return null;

    // web_research is opt-in: only import it when it was actually turned on.
    if (meta.optIn && !enabledFlag) return null;

    const params: Record<string, unknown> = {};
    if (capability === 'embeddings') {
      const dims = this.envNumber('EMBEDDINGS_DIMENSIONS');
      if (dims) params.dimensions = dims;
    }

    return {
      capability,
      provider: {
        protocol: 'openai-compatible',
        baseUrl: baseUrl || meta.defaultBaseUrl || '',
        apiKey: apiKey || null,
      },
      model: model || null,
      timeoutMs,
      params,
      enabled: true,
    };
  }

  private transcription(): DesiredCapability | null {
    const provider = this.env('TRANSCRIPTION_PROVIDER') || 'elevenlabs';
    if (provider === 'whisper') {
      const baseUrl = this.env('WHISPER_BASE_URL');
      if (!baseUrl) return null; // whisper needs a base URL to be usable
      return {
        capability: 'transcription',
        provider: {
          protocol: 'whisper',
          baseUrl,
          apiKey: this.env('WHISPER_API_KEY') || null,
        },
        model: this.env('WHISPER_MODEL') || null,
        timeoutMs: this.envNumber('WHISPER_TIMEOUT_MS'),
        params: pruneUndefined({
          downloadTimeoutMs: this.envNumber('WHISPER_DOWNLOAD_TIMEOUT_MS'),
        }),
        enabled: true,
      };
    }
    // elevenlabs (default)
    const apiKey = this.env('ELEVENLABS_API_KEY');
    if (!apiKey) return null;
    return {
      capability: 'transcription',
      provider: {
        protocol: 'elevenlabs',
        baseUrl: this.env('ELEVENLABS_BASE_URL') || 'https://api.elevenlabs.io/v1',
        apiKey,
      },
      model: this.env('ELEVENLABS_STT_MODEL') || null,
      timeoutMs: this.envNumber('ELEVENLABS_STT_TIMEOUT_MS'),
      params: pruneUndefined({
        tagAudioEvents: this.env('ELEVENLABS_TAG_AUDIO_EVENTS') === 'true' ? true : undefined,
        downloadTimeoutMs: this.envNumber('ELEVENLABS_DOWNLOAD_TIMEOUT_MS'),
      }),
      enabled: true,
    };
  }

  private speakerId(): DesiredCapability | null {
    const provider = this.env('SPEAKER_ID_PROVIDER') || 'pyannoteai';
    if (provider === 'off') return null;
    const apiKey = this.env('PYANNOTEAI_API_KEY');
    if (!apiKey) return null;
    return {
      capability: 'speaker_id',
      provider: {
        protocol: 'pyannoteai',
        baseUrl: this.env('PYANNOTEAI_BASE_URL') || 'https://api.pyannote.ai/v1',
        apiKey,
      },
      model: this.env('PYANNOTEAI_MODEL') || null,
      timeoutMs: this.envNumber('PYANNOTEAI_TIMEOUT_MS'),
      params: pruneUndefined({
        matchThreshold: this.envNumber('PYANNOTEAI_MATCH_THRESHOLD'),
        minEnrollSeconds: this.envNumber('PYANNOTEAI_MIN_ENROLL_SECONDS'),
        voiceprintMaxSeconds: this.envNumber('PYANNOTEAI_VOICEPRINT_MAX_SECONDS'),
        pollIntervalMs: this.envNumber('PYANNOTEAI_POLL_INTERVAL_MS'),
      }),
      enabled: true,
    };
  }

  private env(key: string): string {
    return (this.config.get<string>(key, '') ?? '').trim();
  }

  private envNumber(key: string): number | null {
    const raw = this.env(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
}

function providerKey(p: DesiredProvider): string {
  return `${p.protocol}|${p.baseUrl}|${p.apiKey ?? ''}`;
}

function providerName(p: DesiredProvider): string {
  if (p.protocol === 'elevenlabs') return 'ElevenLabs';
  if (p.protocol === 'pyannoteai') return 'pyannoteAI';
  if (p.protocol === 'whisper') return 'Whisper';
  try {
    return new URL(p.baseUrl).hostname.replace(/^www\./, '') || 'AI provider';
  } catch {
    return 'AI provider';
  }
}

function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let i = 2;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

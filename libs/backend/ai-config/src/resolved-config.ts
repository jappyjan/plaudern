import type { AiCapability, AiProviderProtocol } from '@plaudern/contracts';

/**
 * A fully-resolved, ready-to-use AI configuration for one user + capability.
 * Producing one is the DB-settings replacement for a provider reading env at
 * construction; `AiConfigService.resolve` returns it (or null when the
 * capability is unconfigured/disabled — the pipeline step then no-ops).
 */
export interface ResolvedAiConfig {
  capability: AiCapability;
  protocol: AiProviderProtocol;
  /** Endpoint base URL, trailing slashes trimmed. */
  baseUrl: string;
  /** Bearer/API key, or null for keyless local endpoints. */
  apiKey: string | null;
  /** Effective model id. */
  model: string;
  /** Effective request timeout in ms. */
  timeoutMs: number;
  /** Capability-specific tunables (registry defaults merged with overrides). */
  params: Record<string, unknown>;
  /** The provider connection backing this resolution. */
  providerId: string;
  providerName: string;
}

/** Read a numeric param with a fallback (params are stored as loose JSON). */
export function numberParam(
  config: ResolvedAiConfig,
  key: string,
  fallback: number,
): number {
  const value = config.params[key];
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Read a boolean param with a fallback. */
export function booleanParam(
  config: ResolvedAiConfig,
  key: string,
  fallback: boolean,
): boolean {
  const value = config.params[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

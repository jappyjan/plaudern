import type { ConfigService } from '@nestjs/config';

/** Session cookie: opaque token, httpOnly, SameSite=Lax. */
export const SESSION_COOKIE = 'plaudern_session';
/** Short-lived cookie binding a WebAuthn challenge to the browser. */
export const CHALLENGE_COOKIE = 'plaudern_challenge';

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface AuthConfig {
  /** WebAuthn Relying Party id — the domain the app is served from. */
  rpId: string;
  rpName: string;
  /** Origins accepted in WebAuthn ceremonies (scheme + host [+ port]). */
  origins: string[];
  sessionTtlMs: number;
  allowRegistration: boolean;
  /** Restores the old unauthenticated single-user mode. */
  disabled: boolean;
}

/**
 * All auth settings come from env. The localhost defaults cover local dev
 * (Vite on 5173/4200, API on 3000, nginx on 8080); a real deployment sets
 * AUTH_RP_ID to its domain and gets `https://<domain>` as the only origin.
 */
export function resolveAuthConfig(config: ConfigService): AuthConfig {
  const rpId = config.get<string>('AUTH_RP_ID', 'localhost');
  const originsRaw = config.get<string>('AUTH_ORIGINS', '');
  const origins = originsRaw
    ? originsRaw.split(',').map((origin) => origin.trim()).filter(Boolean)
    : rpId === 'localhost'
      ? [
          'http://localhost:5173',
          'http://localhost:4200',
          'http://localhost:3000',
          'http://localhost:8080',
        ]
      : [`https://${rpId}`];
  const ttlDays = Number(config.get<string>('AUTH_SESSION_TTL_DAYS', '30'));
  return {
    rpId,
    rpName: config.get<string>('AUTH_RP_NAME', 'Plaudern'),
    origins,
    sessionTtlMs: (Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : 30) * 24 * 60 * 60 * 1000,
    allowRegistration: config.get<string>('AUTH_ALLOW_REGISTRATION', 'true') !== 'false',
    disabled: config.get<string>('AUTH_DISABLED', 'false') === 'true',
  };
}

/** Minimal cookie-header parser — enough that we don't need cookie-parser. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // skip malformed values
    }
  }
  return cookies;
}

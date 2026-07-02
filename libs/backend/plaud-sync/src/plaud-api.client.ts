import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PlaudRegion } from '@plaudern/contracts';

/**
 * Minimal client for Plaud's (reverse-engineered) cloud API — the same
 * endpoints the plaud.ai web app uses. Unofficial; not affiliated with Plaud.
 */

/** DI token to inject a fake `fetch` in tests. */
export const PLAUD_FETCH = Symbol('PLAUD_FETCH');

const BASE_URLS: Record<PlaudRegion, string> = {
  us: 'https://api.plaud.ai',
  eu: 'https://api-euc1.plaud.ai',
};

// The API rejects non-browser clients, so masquerade as the web app.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class PlaudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PlaudRecording {
  id: string;
  filename: string;
  /** ISO 8601 capture time, normalized from Plaud's epoch timestamps. */
  startTime: string;
  /** Recording length in ms as reported by Plaud. */
  duration: number | null;
  fileSize: number | null;
  serialNumber: string | null;
  isTrash: boolean;
}

interface RawRecording {
  id?: string | number;
  filename?: string;
  fullname?: string;
  duration?: number;
  filesize?: number;
  start_time?: number | string;
  is_trash?: boolean | number;
  serial_number?: string;
}

/** Plaud sends epoch millis; be defensive about seconds/ISO variants. */
function normalizeStartTime(value: number | string | undefined): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return new Date(value).toISOString();
    if (value > 1e9) return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

@Injectable()
export class PlaudApiClient {
  private readonly fetchFn: typeof fetch;

  constructor(@Optional() @Inject(PLAUD_FETCH) fetchFn?: typeof fetch) {
    this.fetchFn = fetchFn ?? fetch;
  }

  /**
   * POST /auth/access-token with form-encoded email+password. Returns a JWT
   * lasting ~300 days; there is no refresh endpoint — callers re-login instead.
   * Note: the Plaud account must have a password set (the app defaults to OTP).
   */
  async login(
    region: PlaudRegion,
    email: string,
    password: string,
  ): Promise<{ accessToken: string; expiresAt: string }> {
    const body = new URLSearchParams({ username: email, password });
    const res = await this.fetchFn(`${BASE_URLS[region]}/auth/access-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new PlaudApiError(res.status, `Plaud login failed (${res.status}): ${await safeText(res)}`);
    }
    const json = (await res.json()) as { access_token?: string; msg?: string };
    if (!json.access_token) {
      throw new PlaudApiError(res.status, `Plaud login rejected: ${json.msg ?? 'no access_token in response'}`);
    }
    return { accessToken: json.access_token, expiresAt: jwtExpiry(json.access_token) };
  }

  /** GET /user/me — cheap authenticated call used by "test connection". */
  async getMe(region: PlaudRegion, token: string): Promise<void> {
    await this.request(region, token, '/user/me');
  }

  /** GET /file/simple/web — the full recording list (no pagination). */
  async listRecordings(region: PlaudRegion, token: string): Promise<PlaudRecording[]> {
    const res = await this.request(region, token, '/file/simple/web');
    const json = (await res.json()) as { data_file_list?: RawRecording[]; data?: RawRecording[] };
    const raw = json.data_file_list ?? json.data ?? [];
    return raw
      .filter((r) => r.id !== undefined && r.id !== null)
      .map((r) => ({
        id: String(r.id),
        filename: r.filename ?? r.fullname ?? `plaud-${r.id}`,
        startTime: normalizeStartTime(r.start_time),
        duration: typeof r.duration === 'number' ? r.duration : null,
        fileSize: typeof r.filesize === 'number' ? r.filesize : null,
        serialNumber: r.serial_number ?? null,
        isTrash: Boolean(r.is_trash),
      }));
  }

  /**
   * Download audio bytes: prefer the temp-url indirection (a plain HTTPS GET on
   * object storage), fall back to the direct binary endpoint.
   */
  async downloadRecording(
    region: PlaudRegion,
    token: string,
    id: string,
  ): Promise<{ body: Buffer; contentType: string }> {
    const tempUrl = await this.getTempUrl(region, token, id);
    if (tempUrl) {
      const res = await this.fetchFn(tempUrl, { headers: { 'user-agent': USER_AGENT } });
      if (res.ok) return toAudio(res);
    }
    const res = await this.request(region, token, `/file/download/${id}`);
    return toAudio(res);
  }

  private async getTempUrl(region: PlaudRegion, token: string, id: string): Promise<string | null> {
    try {
      const res = await this.request(region, token, `/file/temp-url/${id}?is_opus=false`);
      const json = (await res.json()) as { url?: string; temp_url?: string };
      return json.url ?? json.temp_url ?? null;
    } catch (err) {
      // 401 must bubble so the sync service can re-login; anything else falls
      // back to the direct download endpoint.
      if (err instanceof PlaudApiError && err.status === 401) throw err;
      return null;
    }
  }

  private async request(region: PlaudRegion, token: string, path: string): Promise<Response> {
    const res = await this.fetchFn(`${BASE_URLS[region]}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
      },
    });
    if (!res.ok) {
      throw new PlaudApiError(res.status, `Plaud GET ${path} failed (${res.status}): ${await safeText(res)}`);
    }
    return res;
  }
}

async function toAudio(res: Response): Promise<{ body: Buffer; contentType: string }> {
  const contentType = res.headers.get('content-type');
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType:
      contentType && contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg',
  };
}

async function safeText(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, 300);
}

/** Read expiry from the JWT `exp` claim; fall back to 30 days if unreadable. */
function jwtExpiry(token: string): string {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof payload.exp === 'number') return new Date(payload.exp * 1000).toISOString();
  } catch {
    // fall through
  }
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

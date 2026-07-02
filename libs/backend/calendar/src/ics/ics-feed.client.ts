import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/** DI token so tests can swap in a fake fetch (same pattern as PLAUD_FETCH). */
export const CALENDAR_FETCH = Symbol('CALENDAR_FETCH');
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const FETCH_TIMEOUT_MS = 30_000;
/** Refuse to buffer feeds beyond this — a runaway feed must not OOM the api. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class IcsFetchError extends Error {}

/** Apple/Google hand out webcal:// links; they are plain https underneath. */
export function normalizeFeedUrl(rawUrl: string): string {
  return rawUrl.replace(/^webcal:\/\//i, 'https://');
}

/** Safe-to-log remnant of a secret feed URL: host + last path characters. */
export function maskFeedUrl(rawUrl: string): string {
  try {
    const url = new URL(normalizeFeedUrl(rawUrl));
    const tail = url.pathname.length > 8 ? url.pathname.slice(-8) : url.pathname;
    return `${url.host}/…${tail}`;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Downloads an ICS feed body. The URL is a secret — it must never appear in
 * logs or error messages; only the masked form does.
 */
@Injectable()
export class IcsFeedClient {
  private readonly logger = new Logger(IcsFeedClient.name);
  private readonly fetchImpl: FetchLike;

  constructor(@Optional() @Inject(CALENDAR_FETCH) fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async download(rawUrl: string): Promise<string> {
    const url = normalizeFeedUrl(rawUrl);
    const masked = maskFeedUrl(url);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'text/calendar, text/plain, */*' },
        redirect: 'follow',
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new IcsFetchError(`fetching feed ${masked} failed: ${reason}`);
    }
    if (!res.ok) {
      throw new IcsFetchError(`fetching feed ${masked} failed: HTTP ${res.status}`);
    }
    const length = Number(res.headers?.get?.('content-length') ?? Number.NaN);
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      throw new IcsFetchError(`feed ${masked} is too large (${length} bytes, max ${MAX_RESPONSE_BYTES})`);
    }
    const body = await res.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new IcsFetchError(`feed ${masked} is too large (max ${MAX_RESPONSE_BYTES} bytes)`);
    }
    this.logger.debug(`downloaded feed ${masked} (${body.length} chars)`);
    return body;
  }
}

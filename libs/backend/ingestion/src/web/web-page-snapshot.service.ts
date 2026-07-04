import { Injectable, Inject, Logger } from '@nestjs/common';
import { extractReadableContent, type ReadableContent } from './readability';

/**
 * Injectable fetch so tests (and future proxies) can replace the network.
 * Mirrors the calendar-feed convention: plain global `fetch`, no HTTP client
 * dependency.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; redirect?: 'follow'; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export const WEB_SNAPSHOT_FETCH = Symbol('WEB_SNAPSHOT_FETCH');

/** Abort a page fetch that hasn't answered within this window. */
const FETCH_TIMEOUT_MS = 10_000;
/** Ignore documents larger than this (readable articles are far smaller). */
const MAX_HTML_BYTES = 5 * 1024 * 1024;

/**
 * Fetches a shared URL server-side and reduces it to a readable-text snapshot
 * (`sources/web`, VISION §2). Every failure — network, timeout, non-HTML,
 * oversized, blocked — returns null so ingestion can gracefully fall back to
 * storing just the URL; a share must never fail because a page was slow.
 */
@Injectable()
export class WebPageSnapshotService {
  private readonly logger = new Logger(WebPageSnapshotService.name);
  constructor(@Inject(WEB_SNAPSHOT_FETCH) private readonly fetchImpl: FetchLike) {}

  async snapshot(url: string): Promise<ReadableContent | null> {
    if (!/^https?:\/\//i.test(url)) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
          'user-agent': 'Plaudern/1.0 (+web-clipper; readable snapshot)',
        },
      });
      if (!res.ok) {
        this.logger.warn(`snapshot fetch for ${url} returned ${res.status}`);
        return null;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(contentType)) {
        this.logger.warn(`snapshot fetch for ${url} has unsupported content-type '${contentType}'`);
        return null;
      }
      const raw = await res.text();
      if (Buffer.byteLength(raw) > MAX_HTML_BYTES) {
        this.logger.warn(`snapshot fetch for ${url} exceeds ${MAX_HTML_BYTES} bytes; skipping`);
        return null;
      }
      if (/text\/plain/i.test(contentType)) {
        const text = raw.trim();
        return text ? { title: null, text } : null;
      }
      const content = extractReadableContent(raw);
      return content.text ? content : null;
    } catch (cause) {
      this.logger.warn(
        `snapshot fetch for ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

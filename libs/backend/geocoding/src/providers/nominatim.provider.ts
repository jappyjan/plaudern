import { Injectable, Logger } from '@nestjs/common';
import type { GeocodingProvider } from '../geocoding.provider';

interface NominatimAddress {
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  country?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

const REQUEST_TIMEOUT_MS = 5_000;
// Nominatim's usage policy allows at most 1 request per second.
const MIN_REQUEST_SPACING_MS = 1_100;

/**
 * OSM Nominatim reverse geocoder. Upstream calls are serialized with a
 * ≥1.1 s gap (public-instance usage policy) and deduplicated per coordinate
 * key, so a burst of lookups for the same place costs one request.
 */
@Injectable()
export class NominatimProvider implements GeocodingProvider {
  readonly id = 'nominatim';

  private readonly logger = new Logger(NominatimProvider.name);
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private chain: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly userAgent: string,
  ) {}

  reverse(lat: number, lon: number): Promise<string | null> {
    const key = `${lat},${lon}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.throttled(() => this.fetchLabel(lat, lon)).finally(() =>
      this.inFlight.delete(key),
    );
    this.inFlight.set(key, pending);
    return pending;
  }

  /** Queue `fn` behind all prior upstream calls, spacing them ≥1.1 s apart. */
  private throttled<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async fetchLabel(lat: number, lon: number): Promise<string | null> {
    const url = new URL('/reverse', this.baseUrl);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('zoom', '14');

    const res = await fetch(url, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.warn(`nominatim reverse failed: ${res.status} ${res.statusText}`);
      return null;
    }
    const body = (await res.json()) as NominatimResponse;
    return composeLabel(body);
  }
}

/** Short "street, city, country"-style label from a Nominatim response. */
export function composeLabel(body: NominatimResponse): string | null {
  const address = body.address;
  if (address) {
    const parts = [
      address.road ?? address.neighbourhood ?? address.suburb,
      address.city ?? address.town ?? address.village ?? address.municipality,
      address.country,
    ].filter((p): p is string => Boolean(p));
    if (parts.length > 0) return parts.join(', ');
  }
  if (body.display_name) {
    return body.display_name.split(',').slice(0, 3).map((s) => s.trim()).join(', ');
  }
  return null;
}

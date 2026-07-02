import { useEffect, useState } from 'react';
import type { GeocodeResponse } from '@plaudern/contracts';
import { getPlaceName } from '../lib/api';

// Module-level cache: the server caches persistently, this just avoids
// re-requesting the same coordinates while the SPA stays loaded.
const cache = new Map<string, Promise<GeocodeResponse>>();

function cacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

const EMPTY: GeocodeResponse = { label: null, city: null };

/** Resolves coordinates to a place; label/city stay null while loading/unavailable. */
export function usePlaceName(
  location: { lat: number; lon: number } | undefined,
): GeocodeResponse {
  const [place, setPlace] = useState<GeocodeResponse>(EMPTY);

  // metadata.location is untyped JSON — only trust a proper {lat, lon} shape.
  const valid =
    location &&
    typeof location.lat === 'number' &&
    typeof location.lon === 'number' &&
    Number.isFinite(location.lat) &&
    Number.isFinite(location.lon)
      ? location
      : undefined;
  const key = valid ? cacheKey(valid.lat, valid.lon) : null;

  useEffect(() => {
    if (!valid || !key) return;
    let cancelled = false;
    let pending = cache.get(key);
    if (!pending) {
      pending = getPlaceName(valid.lat, valid.lon).catch(() => EMPTY);
      cache.set(key, pending);
    }
    void pending.then((resolved) => {
      if (!cancelled) setPlace(resolved);
    });
    return () => {
      cancelled = true;
    };
    // location object identity may change every render; key is the stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return place;
}

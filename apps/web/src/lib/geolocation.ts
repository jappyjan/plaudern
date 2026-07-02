export interface GeoLocation {
  lat: number;
  lon: number;
  accuracy?: number;
}

/**
 * Best-effort current position for in-browser recordings. Resolves null on
 * denial, timeout, or insecure context — capturing a note must never fail
 * because location is unavailable. Not used for file uploads: the place a
 * file is uploaded from is not where it was recorded.
 */
export function getLocationOrNull(timeoutMs = 5000): Promise<GeoLocation | null> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        }),
      () => resolve(null),
      { timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}

/**
 * Pluggable reverse-geocoding backend. Concrete impls: Nominatim for real use,
 * a deterministic stub for CI/offline. Selected via `GEOCODER` env at module init.
 */
export interface GeocodingProvider {
  readonly id: string;
  /** Resolve coordinates to a short human-readable label, or null if unknown. */
  reverse(lat: number, lon: number): Promise<string | null>;
}

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

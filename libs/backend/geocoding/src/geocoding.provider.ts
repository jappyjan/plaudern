export interface ReverseGeocodeResult {
  /** Full human-readable line, e.g. "Unter den Linden, Berlin, Germany". */
  label: string;
  /** Just the settlement name (city/town/village), for compact UI. */
  city: string | null;
}

/**
 * Pluggable reverse-geocoding backend. Concrete impls: Nominatim for real use,
 * a deterministic stub for CI/offline. Selected via `GEOCODER` env at module init.
 */
export interface GeocodingProvider {
  readonly id: string;
  /** Resolve coordinates to a place, or null if unknown. */
  reverse(lat: number, lon: number): Promise<ReverseGeocodeResult | null>;
}

export const GEOCODING_PROVIDER = Symbol('GEOCODING_PROVIDER');

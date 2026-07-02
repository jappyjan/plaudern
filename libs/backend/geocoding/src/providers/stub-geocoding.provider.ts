import { Injectable } from '@nestjs/common';
import type { GeocodingProvider, ReverseGeocodeResult } from '../geocoding.provider';

/** Deterministic stub used for CI/offline verification. */
@Injectable()
export class StubGeocodingProvider implements GeocodingProvider {
  readonly id = 'stub';

  async reverse(lat: number, lon: number): Promise<ReverseGeocodeResult | null> {
    return {
      label: `Stub City (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
      city: 'Stub City',
    };
  }
}

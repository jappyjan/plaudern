import { Injectable } from '@nestjs/common';
import type { GeocodingProvider } from '../geocoding.provider';

/** Deterministic stub used for CI/offline verification, mirrors LocalStubProvider. */
@Injectable()
export class StubGeocodingProvider implements GeocodingProvider {
  readonly id = 'stub';

  async reverse(lat: number, lon: number): Promise<string | null> {
    return `Stub City (${lat.toFixed(4)}, ${lon.toFixed(4)})`;
  }
}

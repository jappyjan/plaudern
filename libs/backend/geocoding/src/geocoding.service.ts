import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { GeocodeResponse } from '@plaudern/contracts';
import { GeocodeCacheEntity } from '@plaudern/persistence';
import { GEOCODING_PROVIDER, type GeocodingProvider } from './geocoding.provider';

/** 4 decimals ≈ 11 m — close enough for a place label, coarse enough to cache well. */
export function geocodeCacheKey(lat: number, lon: number): string {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

const EMPTY: GeocodeResponse = { label: null, city: null };

/**
 * Reverse-geocodes coordinates to a human-readable place, with a persistent
 * cache in front of the (rate-limited) provider. Lookups are lazy — items stay
 * immutable and never store the place themselves.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    @InjectRepository(GeocodeCacheEntity)
    private readonly cache: Repository<GeocodeCacheEntity>,
    @Optional()
    @Inject(GEOCODING_PROVIDER)
    private readonly provider: GeocodingProvider | null,
  ) {}

  async resolve(lat: number, lon: number): Promise<GeocodeResponse> {
    if (!this.provider) return EMPTY; // GEOCODER=off

    const key = geocodeCacheKey(lat, lon);
    const cached = await this.cache.findOne({ where: { key } });
    if (cached) return { label: cached.label, city: cached.city };

    try {
      const place = await this.provider.reverse(lat, lon);
      if (place === null) return EMPTY;
      await this.cache.save(
        this.cache.create({
          key,
          lat,
          lon,
          label: place.label,
          city: place.city,
          provider: this.provider.id,
        }),
      );
      return { label: place.label, city: place.city };
    } catch (err) {
      // Geocoder trouble must never break the UI; retry on the next view.
      this.logger.warn(`reverse geocoding failed for ${key}: ${(err as Error).message}`);
      return EMPTY;
    }
  }
}

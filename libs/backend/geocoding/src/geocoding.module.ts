import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeocodeCacheEntity } from '@plaudern/persistence';
import { GEOCODING_PROVIDER, type GeocodingProvider } from './geocoding.provider';
import { NominatimProvider } from './providers/nominatim.provider';
import { StubGeocodingProvider } from './providers/stub-geocoding.provider';
import { GeocodingService } from './geocoding.service';
import { GeocodingController } from './geocoding.controller';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([GeocodeCacheEntity])],
  providers: [
    StubGeocodingProvider,
    {
      provide: GEOCODING_PROVIDER,
      inject: [ConfigService, StubGeocodingProvider],
      useFactory: (
        config: ConfigService,
        stub: StubGeocodingProvider,
      ): GeocodingProvider | null => {
        switch (config.get<string>('GEOCODER', 'nominatim')) {
          case 'off':
            return null;
          case 'stub':
            return stub;
          default:
            return new NominatimProvider(
              config.get<string>('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
              config.get<string>('GEOCODER_USER_AGENT', 'plaudern/0.1 (self-hosted)'),
            );
        }
      },
    },
    GeocodingService,
  ],
  controllers: [GeocodingController],
  exports: [GeocodingService],
})
export class GeocodingModule {}

import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { geocodeQuerySchema, type GeocodeResponse } from '@plaudern/contracts';
import { GeocodingService } from './geocoding.service';

@Controller({ path: 'geocode', version: '1' })
export class GeocodingController {
  constructor(private readonly geocoding: GeocodingService) {}

  @Get()
  async reverse(@Query() query: Record<string, unknown>): Promise<GeocodeResponse> {
    // No global ZodError filter exists, so a raw .parse() would surface as 500.
    const parsed = geocodeQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('invalid lat/lon');
    const { lat, lon } = parsed.data;
    return { label: await this.geocoding.resolve(lat, lon) };
  }
}

import { z } from 'zod';

export const geocodeQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});
export type GeocodeQuery = z.infer<typeof geocodeQuerySchema>;

/**
 * `label` is the full "street, city, country" line; `city` is just the
 * settlement name for compact display. Both null when the geocoder is
 * disabled or the lookup failed.
 */
export const geocodeResponseSchema = z.object({
  label: z.string().nullable(),
  city: z.string().nullable(),
});
export type GeocodeResponse = z.infer<typeof geocodeResponseSchema>;

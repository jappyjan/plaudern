import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * Cache of reverse-geocoding results keyed by coordinates rounded to
 * 4 decimals (~11 m). Keeps the app polite to the upstream geocoder
 * (Nominatim allows 1 req/s) and makes repeat lookups instant.
 */
@Entity({ name: 'geocode_cache' })
export class GeocodeCacheEntity {
  /** `"<lat>,<lon>"` with both values rounded to 4 decimals, e.g. `"52.5200,13.4050"`. */
  @PrimaryColumn({ type: 'varchar' })
  key!: string;

  @Column({ type: 'float' })
  lat!: number;

  @Column({ type: 'float' })
  lon!: number;

  @Column({ type: 'text', nullable: true })
  label!: string | null;

  /** Bare settlement name (city/town/village) for compact display. */
  @Column({ type: 'varchar', nullable: true })
  city!: string | null;

  @Column({ type: 'varchar' })
  provider!: string;

  @CreateDateColumn()
  createdAt!: Date;
}

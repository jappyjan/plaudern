import { MigrationInterface, QueryRunner } from 'typeorm';

/** Cache table for reverse-geocoding lookups (see GeocodeCacheEntity). */
export class GeocodeCache1720000000003 implements MigrationInterface {
  name = 'GeocodeCache1720000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "geocode_cache" (
        "key" character varying NOT NULL,
        "lat" double precision NOT NULL,
        "lon" double precision NOT NULL,
        "label" text,
        "city" character varying,
        "provider" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_geocode_cache" PRIMARY KEY ("key")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "geocode_cache"`);
  }
}

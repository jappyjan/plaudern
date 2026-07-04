import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entity merge & correction durability (JJ-63). Two per-user side tables that
 * make manual corrections survive re-extraction and backfills:
 *
 * - `entity_aliases`: a normalized name that must resolve to a specific
 *   surviving entity. When two entities are merged, the merged-away
 *   (victim) names are recorded here pointing at the survivor, so the next
 *   extraction/backfill that sees the victim's name upserts onto the survivor
 *   instead of resurrecting a duplicate. Renaming an entity records the OLD
 *   normalized name here too. Keyed (userId, type, normalizedName) — mirroring
 *   the `entities` dedupe key — so resolution is type-scoped.
 *
 * - `entity_suppressions`: normalized names the user deleted/suppressed that
 *   must NOT be recreated. The registry upsert path consults this and skips
 *   both the entity and its mention when a name is suppressed.
 *
 * Additive only: safe on existing installs.
 */
export class CreateEntityCorrections1720000000027 implements MigrationInterface {
  name = 'CreateEntityCorrections1720000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "entity_aliases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "entityId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "normalizedName" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_aliases" PRIMARY KEY ("id"),
        CONSTRAINT "FK_entity_aliases_entity" FOREIGN KEY ("entityId")
          REFERENCES "entities"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_aliases_entityId" ON "entity_aliases" ("entityId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entity_aliases_user_type_name" ON "entity_aliases" ("userId", "type", "normalizedName")`,
    );

    await queryRunner.query(`
      CREATE TABLE "entity_suppressions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "normalizedName" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_suppressions" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entity_suppressions_user_type_name" ON "entity_suppressions" ("userId", "type", "normalizedName")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "entity_suppressions"`);
    await queryRunner.query(`DROP TABLE "entity_aliases"`);
  }
}

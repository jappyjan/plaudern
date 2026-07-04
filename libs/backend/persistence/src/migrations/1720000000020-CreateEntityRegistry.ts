import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Entity registry + mentions (JJ-32): the seed of the knowledge graph. The
 * `entities` extractor pulls named entities from a recording's transcript,
 * normalizes them into per-user `entities` rows (deduped on
 * userId+type+normalizedName), and records one `entity_mentions` edge per
 * (extraction, entity). `person` rows link to a voice profile via
 * `voiceProfileId`. Additive only: safe on existing installs.
 */
export class CreateEntityRegistry1720000000020 implements MigrationInterface {
  name = 'CreateEntityRegistry1720000000020';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "entities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" character varying NOT NULL,
        "canonicalName" character varying NOT NULL,
        "normalizedName" character varying NOT NULL,
        "aliases" text NOT NULL,
        "voiceProfileId" uuid,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entities" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_entities_userId" ON "entities" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entities_user_type_name" ON "entities" ("userId", "type", "normalizedName")`,
    );

    await queryRunner.query(`
      CREATE TABLE "entity_mentions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "entityId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "surfaceForm" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_mentions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_entity_mentions_entity" FOREIGN KEY ("entityId")
          REFERENCES "entities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_mentions_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_mentions_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_mentions_inboxItemId" ON "entity_mentions" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_mentions_entityId" ON "entity_mentions" ("entityId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entity_mentions_extraction_entity" ON "entity_mentions" ("extractionId", "entityId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "entity_mentions"`);
    await queryRunner.query(`DROP TABLE "entities"`);
  }
}

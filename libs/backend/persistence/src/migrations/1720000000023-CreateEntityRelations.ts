import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge-graph edges (JJ-22): the `relations` extractor pulls typed
 * relations between a recording's entities out of its transcript (plus weak
 * implicit co-occurrence edges) and records one `entity_relations` evidence
 * row per (extraction, source, target, relationType) — mirroring
 * `entity_mentions`, so append-only reprocessing supersedes old evidence.
 * Additive only: safe on existing installs.
 */
export class CreateEntityRelations1720000000023 implements MigrationInterface {
  name = 'CreateEntityRelations1720000000023';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "entity_relations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "sourceEntityId" uuid NOT NULL,
        "targetEntityId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "relationType" character varying NOT NULL,
        "label" character varying,
        "confidence" double precision,
        "origin" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_relations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_entity_relations_source" FOREIGN KEY ("sourceEntityId")
          REFERENCES "entities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_relations_target" FOREIGN KEY ("targetEntityId")
          REFERENCES "entities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_relations_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_relations_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_relations_userId" ON "entity_relations" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_relations_inboxItemId" ON "entity_relations" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_relations_sourceEntityId" ON "entity_relations" ("sourceEntityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_relations_targetEntityId" ON "entity_relations" ("targetEntityId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entity_relations_evidence" ON "entity_relations" ("extractionId", "sourceEntityId", "targetEntityId", "relationType")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "entity_relations"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Duplicate merge suggestions (JJ-63). One row per detected likely-duplicate
 * pair the user may want to merge — written automatically after extraction
 * (cheap exact cross-type detection) or on demand. Only ever RECORDS a
 * suggestion; merges themselves stay user-confirmed via the correction path.
 *
 * The pair is stored canonicalized (`entityId` = smaller id, then
 * `candidateEntityId`) with a unique key over both, so A↔B and B↔A collapse to
 * one row. Both id columns reference `entities` ON DELETE CASCADE, so a merge
 * that deletes the victim drops its suggestions with it.
 *
 * Additive only: safe on existing installs.
 */
export class CreateEntityMergeSuggestions1720000000039 implements MigrationInterface {
  name = 'CreateEntityMergeSuggestions1720000000039';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "entity_merge_suggestions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "entityId" uuid NOT NULL,
        "candidateEntityId" uuid NOT NULL,
        "recommendedSurvivorId" uuid,
        "recommendedType" character varying,
        "sameThing" boolean,
        "confidence" double precision,
        "rationale" text,
        "usedWeb" boolean NOT NULL DEFAULT false,
        "source" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_entity_merge_suggestions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_entity_merge_suggestions_entity" FOREIGN KEY ("entityId")
          REFERENCES "entities"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_entity_merge_suggestions_candidate" FOREIGN KEY ("candidateEntityId")
          REFERENCES "entities"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_entity_merge_suggestions_pair" ON "entity_merge_suggestions" ("userId", "entityId", "candidateEntityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_entity_merge_suggestions_user_status" ON "entity_merge_suggestions" ("userId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "entity_merge_suggestions"`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Personal-facts extraction (JJ-31): a user-scoped `personal_facts` table
 * holding durable facts about the people in the user's life ("her birthday is in
 * March", "he's allergic to nuts", gift ideas), each scoped to a subject (linked
 * to a registry `person` entity when the name matches, else kept as a raw name)
 * and deduplicated across recordings into one row with many
 * `personal_fact_citations` — mirroring the tasks / task_citations shape.
 *
 * APPEND-ONLY with SUPERSESSION: `supersededByFactId` / `supersededAt` mark an
 * older fact when a newer one about the same (subject, attribute) with a
 * different value arrives, WITHOUT deleting it, preserving the timeline for the
 * dossier (JJ-24). Deduped on (userId, subjectKey, normalizedAttribute,
 * normalizedValue) so re-runs and repeated mentions upsert onto the same row.
 * `personal_fact_citations` are unique per (extractionId, factId) so ingestion
 * is idempotent. Additive only — safe on existing installs.
 */
export class CreatePersonalFacts1720000000031 implements MigrationInterface {
  name = 'CreatePersonalFacts1720000000031';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "personal_facts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "personEntityId" uuid,
        "personName" character varying NOT NULL DEFAULT '',
        "subjectKey" character varying NOT NULL,
        "attribute" character varying NOT NULL,
        "normalizedAttribute" character varying NOT NULL,
        "value" text NOT NULL,
        "normalizedValue" character varying NOT NULL,
        "supersededByFactId" uuid,
        "supersededAt" character varying,
        "lastOccurredAt" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_personal_facts" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_personal_facts_userId" ON "personal_facts" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_personal_facts_personEntityId" ON "personal_facts" ("personEntityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_personal_facts_user_subject" ON "personal_facts" ("userId", "subjectKey")`,
    );
    // Dedupe key: one row per (user, subject, attribute, value). Re-runs,
    // backfills and repeated mentions upsert onto the same row.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_personal_facts_dedupe" ON "personal_facts" ("userId", "subjectKey", "normalizedAttribute", "normalizedValue")`,
    );

    await queryRunner.query(`
      CREATE TABLE "personal_fact_citations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "factId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "quote" text,
        "startSeconds" double precision,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_personal_fact_citations" PRIMARY KEY ("id"),
        CONSTRAINT "FK_personal_fact_citations_fact" FOREIGN KEY ("factId")
          REFERENCES "personal_facts"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_personal_fact_citations_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_personal_fact_citations_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_personal_fact_citations_inboxItemId" ON "personal_fact_citations" ("inboxItemId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_personal_fact_citations_factId" ON "personal_fact_citations" ("factId")`,
    );
    // Idempotent ingestion: one citation per fact per extraction, so a re-run or
    // backfill never duplicates citations.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_personal_fact_citations_extraction_fact" ON "personal_fact_citations" ("extractionId", "factId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "personal_fact_citations"`);
    await queryRunner.query(`DROP TABLE "personal_facts"`);
  }
}

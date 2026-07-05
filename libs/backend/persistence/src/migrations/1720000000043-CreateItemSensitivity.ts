import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sensitivity classification per inbox item (JJ-21): the `sentinel` extractor
 * detects passwords, IBANs, card numbers, national IDs, health details and
 * other secrets in an item's transcript and stores the resulting tier here.
 * The tier gates local-only routing (sensitive/secret content never goes to an
 * external LLM) and masking in the UI.
 *
 * `detectedTier` is extraction-owned (a re-run overwrites it); `manualTier` is
 * user-owned and survives re-classification. `held`/`heldReason` track an item
 * whose external-LLM extractions were withheld for lack of a local model tier.
 * One row per item (unique inboxItemId). Additive only — safe on existing
 * installs.
 */
export class CreateItemSensitivity1720000000043 implements MigrationInterface {
  name = 'CreateItemSensitivity1720000000043';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "item_sensitivity" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "detectedTier" character varying NOT NULL DEFAULT 'normal',
        "manualTier" character varying,
        "detections" text,
        "spans" text,
        "llmClassified" boolean NOT NULL DEFAULT false,
        "held" boolean NOT NULL DEFAULT false,
        "heldReason" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_item_sensitivity" PRIMARY KEY ("id"),
        CONSTRAINT "FK_item_sensitivity_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_item_sensitivity_userId" ON "item_sensitivity" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_item_sensitivity_item" ON "item_sensitivity" ("inboxItemId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "item_sensitivity"`);
  }
}

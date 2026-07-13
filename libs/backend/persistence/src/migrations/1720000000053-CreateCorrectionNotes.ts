import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * User correction notes: a user-scoped `correction_notes` table holding
 * free-text remarks on an inbox item ("the name is 'Meier', not 'Maier'")
 * that are injected into summary (re)generation as authoritative corrections.
 *
 * Notes live outside the append-only inbox aggregate — they are user input,
 * not derived data — so rows may be inserted and deleted freely while the
 * source blob and its extraction rows stay untouched. Additive only — safe on
 * existing installs.
 */
export class CreateCorrectionNotes1720000000053 implements MigrationInterface {
  name = 'CreateCorrectionNotes1720000000053';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "correction_notes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "body" text NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_correction_notes" PRIMARY KEY ("id"),
        CONSTRAINT "FK_correction_notes_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_correction_notes_userId" ON "correction_notes" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_correction_notes_item" ON "correction_notes" ("inboxItemId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "correction_notes"`);
  }
}

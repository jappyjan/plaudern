import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Merged recordings: link rows tying a merged inbox item to the (hidden but
 * untouched) source recordings it was concatenated from, in playback order.
 * The source FK deliberately has no ON DELETE CASCADE — a hidden source must
 * not be deletable while its merge exists (split first). Additive only.
 */
export class CreateRecordingMerges1720000000014 implements MigrationInterface {
  name = 'CreateRecordingMerges1720000000014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recording_merges" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "mergedItemId" uuid NOT NULL,
        "sourceItemId" uuid NOT NULL,
        "position" integer NOT NULL,
        "sourceDurationSeconds" double precision NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recording_merges" PRIMARY KEY ("id"),
        CONSTRAINT "FK_recording_merges_merged" FOREIGN KEY ("mergedItemId") REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_recording_merges_source" FOREIGN KEY ("sourceItemId") REFERENCES "inbox_items"("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_recording_merges_userId" ON "recording_merges" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_recording_merges_source" ON "recording_merges" ("sourceItemId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_recording_merges_merged_position" ON "recording_merges" ("mergedItemId", "position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "recording_merges"`);
  }
}

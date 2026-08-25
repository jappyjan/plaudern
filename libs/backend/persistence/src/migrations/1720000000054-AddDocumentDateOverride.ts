import { MigrationInterface, QueryRunner } from 'typeorm';

/** A user-owned effective-date override, kept separate from extracted metadata. */
export class AddDocumentDateOverride1720000000054 implements MigrationInterface {
  name = 'AddDocumentDateOverride1720000000054';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_metadata" ADD COLUMN "documentDateOverride" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_metadata" DROP COLUMN "documentDateOverride"`,
    );
  }
}

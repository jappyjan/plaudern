import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Add `documentDate` to `document_metadata`: the date printed on the scanned
 * document itself (issue/invoice/letter/statement date), resolved to an
 * absolute ISO datetime by the `docmeta` extractor. When present it is preferred
 * over the item's capture time (`occurredAt`) as the displayed date — the
 * immutable inbox envelope is left untouched. Additive and nullable — safe on
 * existing installs (a docmeta re-run backfills older documents).
 */
export class AddDocumentDate1720000000046 implements MigrationInterface {
  name = 'AddDocumentDate1720000000046';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_metadata" ADD COLUMN "documentDate" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "document_metadata" DROP COLUMN "documentDate"`,
    );
  }
}

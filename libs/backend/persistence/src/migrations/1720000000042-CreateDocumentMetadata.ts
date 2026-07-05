import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Document metadata (JJ-30 photo/scan understanding + JJ-16 vault): a
 * user-scoped `document_metadata` table holding the structured understanding of
 * a scanned image or PDF — document type, key fields, monetary/IBAN details and
 * the expiry + Kündigungsfrist (cancellation) dates that drive deadline
 * reminders. Powers the vault view (grouped by documentType).
 *
 * ONE row per inbox item (unique on inboxItemId) so re-OCR upserts onto the
 * same row instead of duplicating; `extractionId` is repointed to the latest
 * `docmeta` generation for provenance. Additive only — safe on existing
 * installs.
 */
export class CreateDocumentMetadata1720000000042 implements MigrationInterface {
  name = 'CreateDocumentMetadata1720000000042';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_metadata" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "extractionId" uuid NOT NULL,
        "documentType" character varying NOT NULL,
        "title" text NOT NULL,
        "summary" text,
        "issuer" text,
        "fields" text,
        "amount" double precision,
        "currency" character varying,
        "iban" character varying,
        "expiryDate" character varying,
        "cancellationDate" character varying,
        "contact" text,
        "confidence" double precision,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_metadata" PRIMARY KEY ("id"),
        CONSTRAINT "FK_document_metadata_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_document_metadata_extraction" FOREIGN KEY ("extractionId")
          REFERENCES "extracted_payloads"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_document_metadata_userId" ON "document_metadata" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_metadata_user_type" ON "document_metadata" ("userId", "documentType")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_document_metadata_item" ON "document_metadata" ("inboxItemId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "document_metadata"`);
  }
}

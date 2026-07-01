import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1720000000000 implements MigrationInterface {
  name = 'InitialSchema1720000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_users_email" UNIQUE ("email"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )`);

    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "kind" character varying NOT NULL DEFAULT 'generic',
        "externalRef" character varying,
        "apiKeyHash" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_devices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_devices_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_devices_apiKeyHash" ON "devices" ("apiKeyHash")`,
    );

    await queryRunner.query(`
      CREATE TABLE "inbox_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "deviceId" uuid,
        "sourceType" character varying NOT NULL,
        "occurredAt" character varying NOT NULL,
        "ingestedAt" TIMESTAMP NOT NULL DEFAULT now(),
        "idempotencyKey" character varying NOT NULL,
        "metadata" text,
        CONSTRAINT "PK_inbox_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_inbox_items_user_ingestedAt" ON "inbox_items" ("userId", "ingestedAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_inbox_items_user_idempotencyKey" ON "inbox_items" ("userId", "idempotencyKey")`,
    );

    await queryRunner.query(`
      CREATE TABLE "source_payloads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "inboxItemId" uuid NOT NULL,
        "storageKey" character varying NOT NULL,
        "contentType" character varying NOT NULL,
        "byteSize" bigint NOT NULL DEFAULT 0,
        "checksum" character varying,
        "originalFilename" character varying,
        "uploadStatus" character varying NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_source_payloads" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_source_payloads_inboxItemId" UNIQUE ("inboxItemId"),
        CONSTRAINT "FK_source_payloads_item" FOREIGN KEY ("inboxItemId") REFERENCES "inbox_items"("id") ON DELETE CASCADE
      )`);

    await queryRunner.query(`
      CREATE TABLE "extracted_payloads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "inboxItemId" uuid NOT NULL,
        "kind" character varying NOT NULL,
        "provider" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'queued',
        "content" text,
        "contentStorageKey" character varying,
        "language" character varying,
        "error" text,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "completedAt" character varying,
        CONSTRAINT "PK_extracted_payloads" PRIMARY KEY ("id"),
        CONSTRAINT "FK_extracted_payloads_item" FOREIGN KEY ("inboxItemId") REFERENCES "inbox_items"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_extracted_payloads_item_kind" ON "extracted_payloads" ("inboxItemId", "kind")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "extracted_payloads"`);
    await queryRunner.query(`DROP TABLE "source_payloads"`);
    await queryRunner.query(`DROP TABLE "inbox_items"`);
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}

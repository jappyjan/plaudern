import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification engine tables (ATT-661): per-user settings + quiet hours,
 * per-category channel opt-in & frequency cap, registered web-push
 * subscriptions, and an append-only delivery log backing the caps. Additive
 * only — safe on existing installs; users without rows fall back to defaults.
 */
export class CreateNotificationTables1720000000017 implements MigrationInterface {
  name = 'CreateNotificationTables1720000000017';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "notification_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "timezone" character varying NOT NULL DEFAULT 'UTC',
        "emailAddress" character varying,
        "quietHoursEnabled" boolean NOT NULL DEFAULT true,
        "quietHoursStart" character varying NOT NULL DEFAULT '22:00',
        "quietHoursEnd" character varying NOT NULL DEFAULT '07:00',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_settings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notification_settings_userId" ON "notification_settings" ("userId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_category_preferences" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "category" character varying NOT NULL,
        "channels" text NOT NULL,
        "maxPerDay" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_category_preferences" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_notification_category_prefs_userId_category" ON "notification_category_preferences" ("userId", "category")`,
    );

    await queryRunner.query(`
      CREATE TABLE "push_subscriptions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "endpoint" text NOT NULL,
        "p256dh" text NOT NULL,
        "auth" text NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_subscriptions" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_push_subscriptions_userId" ON "push_subscriptions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_push_subscriptions_endpoint" ON "push_subscriptions" ("endpoint")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_deliveries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "category" character varying NOT NULL,
        "channels" text NOT NULL,
        "status" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_deliveries" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_deliveries_userId_category_createdAt" ON "notification_deliveries" ("userId", "category", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "notification_deliveries"`);
    await queryRunner.query(`DROP TABLE "push_subscriptions"`);
    await queryRunner.query(`DROP TABLE "notification_category_preferences"`);
    await queryRunner.query(`DROP TABLE "notification_settings"`);
  }
}

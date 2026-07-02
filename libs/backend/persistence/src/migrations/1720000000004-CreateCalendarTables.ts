import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Calendar feeds (ICS subscriptions), cached event instances, and
 * recording↔event links, plus an occurredAt index on inbox_items for
 * time-range matching. Additive only — safe on existing installs.
 */
export class CreateCalendarTables1720000000004 implements MigrationInterface {
  name = 'CreateCalendarTables1720000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "calendar_feeds" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "name" character varying NOT NULL,
        "providerType" character varying NOT NULL,
        "urlEncrypted" text NOT NULL,
        "urlHash" character varying NOT NULL,
        "urlMasked" character varying NOT NULL,
        "color" character varying,
        "enabled" boolean NOT NULL DEFAULT true,
        "lastSyncAt" character varying,
        "lastSyncStatus" character varying,
        "lastSyncError" text,
        "lastSyncEventCount" integer,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_calendar_feeds" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_calendar_feeds_userId_urlHash" ON "calendar_feeds" ("userId", "urlHash")`,
    );

    await queryRunner.query(`
      CREATE TABLE "calendar_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "feedId" uuid NOT NULL,
        "externalUid" character varying NOT NULL,
        "instanceStart" character varying NOT NULL,
        "startAt" character varying NOT NULL,
        "endAt" character varying NOT NULL,
        "isAllDay" boolean NOT NULL DEFAULT false,
        "title" character varying,
        "description" text,
        "location" character varying,
        "timezone" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_calendar_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_calendar_events_feed" FOREIGN KEY ("feedId")
          REFERENCES "calendar_feeds"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_calendar_events_identity" ON "calendar_events" ("feedId", "externalUid", "instanceStart")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_calendar_events_userId_startAt" ON "calendar_events" ("userId", "startAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_calendar_events_userId_endAt" ON "calendar_events" ("userId", "endAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "recording_event_links" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "inboxItemId" uuid NOT NULL,
        "calendarEventId" uuid NOT NULL,
        "origin" character varying NOT NULL,
        "status" character varying NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_recording_event_links" PRIMARY KEY ("id"),
        CONSTRAINT "FK_recording_event_links_item" FOREIGN KEY ("inboxItemId")
          REFERENCES "inbox_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_recording_event_links_event" FOREIGN KEY ("calendarEventId")
          REFERENCES "calendar_events"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_recording_event_links_pair" ON "recording_event_links" ("inboxItemId", "calendarEventId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_recording_event_links_eventId" ON "recording_event_links" ("calendarEventId")`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_inbox_items_userId_occurredAt" ON "inbox_items" ("userId", "occurredAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_inbox_items_userId_occurredAt"`);
    await queryRunner.query(`DROP TABLE "recording_event_links"`);
    await queryRunner.query(`DROP TABLE "calendar_events"`);
    await queryRunner.query(`DROP TABLE "calendar_feeds"`);
  }
}

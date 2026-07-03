import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  ALL_ENTITIES,
  ALL_MIGRATIONS,
  DEFAULT_USER_ID,
  USER_OWNED_DATA_TABLES,
} from '@plaudern/persistence';

/**
 * Integration guard for the boot path (plan §6): a real Postgres in a throwaway
 * container, the REAL migrations (not sqlite `synchronize`). It proves two
 * things the unit/e2e suites structurally cannot:
 *
 *  1. `nx serve api` will actually come up — the full migration chain applies
 *     cleanly on Postgres and the app answers requests.
 *  2. The DeSentinelizeOwner repair migration's Postgres-specific DDL (drop /
 *     re-add the owner FKs around a primary-key re-key) really works, carrying
 *     every FK child and owned row from the sentinel id to a fresh UUID.
 */
jest.setTimeout(180_000);

const DE_SENTINELIZE = 'DeSentinelizeOwner1720000000009';

describe('Migrations & app boot (integration, real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let baseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('plaudern')
      .withUsername('plaudern')
      .withPassword('plaudern')
      .start();
    baseUrl = container.getConnectionUri();
  });

  afterAll(async () => {
    await container?.stop();
  });

  describe('the app boots on a freshly migrated database', () => {
    let app: INestApplication;

    beforeAll(async () => {
      process.env.DATABASE_DRIVER = 'postgres';
      process.env.DATABASE_URL = baseUrl;
      // `false` => migrationsRun, so this exercises the real migrations rather
      // than TypeORM's schema synchronize.
      process.env.DATABASE_SYNCHRONIZE = 'false';
      process.env.STORAGE_DRIVER = 'memory';
      process.env.QUEUE_DRIVER = 'inline';
      process.env.GEOCODER = 'stub';
      process.env.AUTH_DISABLED = 'false';

      const moduleRef = await Test.createTestingModule({
        imports: [(await import('./app.module')).AppModule],
      }).compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI });
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('starts successfully and answers health', async () => {
      await request(app.getHttpServer()).get('/api/health').expect(200);
    });

    it('serves auth status on the migrated schema (no users yet)', async () => {
      const res = await request(app.getHttpServer()).get('/api/v1/auth/status').expect(200);
      expect(res.body).toMatchObject({ usersExist: false, authDisabled: false });
    });

    it('actually ran every migration (recorded in the migrations table)', async () => {
      const ds = app.get(DataSource);
      const rows: Array<{ name: string }> = await ds.query('SELECT name FROM migrations');
      const ran = rows.map((r) => r.name).sort();
      const expected = ALL_MIGRATIONS.map((m) => m.name).sort();
      expect(ran).toEqual(expected);
    });
  });

  describe('DeSentinelizeOwner repairs a broken sentinel-owned account', () => {
    let dbUrl: string;

    beforeAll(async () => {
      // Isolated database on the same server so this scenario starts from a
      // clean schema, independent of the boot test above.
      const admin = new DataSource({ type: 'postgres', url: baseUrl });
      await admin.initialize();
      await admin.query('CREATE DATABASE desentinelize_test');
      await admin.destroy();

      const u = new URL(baseUrl);
      u.pathname = '/desentinelize_test';
      dbUrl = u.toString();
    });

    it('re-keys the owner to a real UUID, carrying FK children and owned rows', async () => {
      // 1. Migrate to the exact state the buggy build shipped: everything up to
      //    but NOT including the repair migration.
      const pre = new DataSource({
        type: 'postgres',
        url: dbUrl,
        entities: ALL_ENTITIES,
        migrations: ALL_MIGRATIONS.filter((m) => m.name !== DE_SENTINELIZE),
      });
      await pre.initialize();
      await pre.runMigrations();

      // 2. Reproduce the damage: an owner created with the static sentinel id,
      //    plus a passkey and session (FK children) and owned rows.
      await pre.query(
        `INSERT INTO "users"("id","username","webauthnUserId") VALUES ($1,'jappy','handle-jappy')`,
        [DEFAULT_USER_ID],
      );
      await pre.query(
        `INSERT INTO "passkey_credentials"("id","userId","publicKey","deviceType") VALUES ('cred-1',$1,'pk-bytes','singleDevice')`,
        [DEFAULT_USER_ID],
      );
      await pre.query(
        `INSERT INTO "auth_sessions"("tokenHash","userId","expiresAt") VALUES ('token-hash-1',$1,'2999-01-01T00:00:00.000Z')`,
        [DEFAULT_USER_ID],
      );
      await pre.query(
        `INSERT INTO "inbox_items"("userId","sourceType","occurredAt","idempotencyKey") VALUES ($1,'text','2026-07-01T00:00:00.000Z','legacy-key-1')`,
        [DEFAULT_USER_ID],
      );
      await pre.query(
        `INSERT INTO "inbox_tombstones"("userId","idempotencyKey","deletedItemId","sourceType") VALUES ($1,'tomb-key-1',$2,'text')`,
        [DEFAULT_USER_ID, randomUUID()],
      );
      await pre.destroy();

      // 3. Run only the repair migration (the rest are already recorded).
      const post = new DataSource({
        type: 'postgres',
        url: dbUrl,
        entities: ALL_ENTITIES,
        migrations: ALL_MIGRATIONS,
      });
      await post.initialize();
      const applied = await post.runMigrations();
      expect(applied.map((m) => m.name)).toEqual([DE_SENTINELIZE]);

      // 4. The sentinel id is gone; a single real-UUID owner replaced it.
      const stillSentinel = await post.query(`SELECT id FROM "users" WHERE id = $1`, [
        DEFAULT_USER_ID,
      ]);
      expect(stillSentinel).toHaveLength(0);

      const users: Array<{ id: string }> = await post.query('SELECT id FROM "users"');
      expect(users).toHaveLength(1);
      const newId = users[0].id;
      expect(newId).not.toBe(DEFAULT_USER_ID);
      expect(newId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );

      // 5. No child or owned row was left stranded on the sentinel id, and the
      //    FK children point at the new owner.
      for (const table of ['passkey_credentials', 'auth_sessions', ...USER_OWNED_DATA_TABLES]) {
        const stranded = await post.query(`SELECT 1 FROM "${table}" WHERE "userId" = $1`, [
          DEFAULT_USER_ID,
        ]);
        expect(stranded).toHaveLength(0);
      }
      const cred: Array<{ userId: string }> = await post.query(
        'SELECT "userId" FROM "passkey_credentials"',
      );
      expect(cred[0].userId).toBe(newId);

      // 6. The owner FKs were restored, not silently dropped: deleting the user
      //    cascades to its passkey and session again.
      await post.query(`DELETE FROM "users" WHERE id = $1`, [newId]);
      expect(await post.query('SELECT 1 FROM "passkey_credentials"')).toHaveLength(0);
      expect(await post.query('SELECT 1 FROM "auth_sessions"')).toHaveLength(0);

      await post.destroy();
    });
  });
});

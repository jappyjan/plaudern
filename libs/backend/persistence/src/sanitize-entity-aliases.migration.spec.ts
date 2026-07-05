import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { ALL_ENTITIES } from './persistence.module';
import { EntityRegistryEntity } from './entities';
import { SanitizeEntityAliases1720000000040 } from './migrations/1720000000040-SanitizeEntityAliases';

const USER = '00000000-0000-0000-0000-0000000000aa';

/**
 * The migration runs on Postgres in production, but its logic is DB-agnostic
 * (EntityManager + the `aliases` simple-json transformer), so we exercise it on
 * sqlite to prove it actually cleans persisted rows and is idempotent — neither
 * of which `migrations.spec.ts` (registration only) or the Postgres smoke
 * (empty DB) covers.
 */
describe('SanitizeEntityAliases1720000000040', () => {
  let dataSource: DataSource;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function insertEntity(canonicalName: string, aliases: string[]): Promise<string> {
    const row = await dataSource.getRepository(EntityRegistryEntity).save({
      userId: USER,
      type: 'person',
      canonicalName,
      normalizedName: canonicalName.toLowerCase(),
      aliases,
      voiceProfileId: null,
      voiceProfileLinkOrigin: null,
    });
    return row.id;
  }

  async function aliasesOf(id: string): Promise<string[]> {
    const row = await dataSource.getRepository(EntityRegistryEntity).findOneByOrFail({ id });
    return row.aliases;
  }

  async function runUp(): Promise<void> {
    const queryRunner = dataSource.createQueryRunner();
    try {
      await new SanitizeEntityAliases1720000000040().up(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  it('strips pronouns and generic nouns from existing rows, keeping real names', async () => {
    const id = await insertEntity('Patient', [
      'Patient', 'Sie', 'Ihnen', 'Ihre', 'Ihrer', 'Ihrem', 'Jan', 'Jan Jaap',
    ]);

    await runUp();

    expect(await aliasesOf(id)).toEqual(['Jan', 'Jan Jaap']);
  });

  it('leaves already-clean rows untouched and is idempotent', async () => {
    const clean = await insertEntity('Angela Merkel', ['Angela', 'Frau Merkel']);
    const dirty = await insertEntity('Patient', ['Sie', 'Jan']);

    await runUp();
    await runUp(); // second pass must be a no-op

    expect(await aliasesOf(clean)).toEqual(['Angela', 'Frau Merkel']);
    expect(await aliasesOf(dirty)).toEqual(['Jan']);
  });
});

import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type { ExtractedEntity } from '@plaudern/contracts';
import {
  EntitiesRegistryService,
  isUniqueViolation,
  normalize,
} from './entities-registry.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('normalize', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalize('  Angela   Merkel ')).toBe('angela merkel');
    expect(normalize('ACME')).toBe('acme');
  });
});

describe('isUniqueViolation', () => {
  it('recognizes a Postgres unique_violation (SQLSTATE 23505)', () => {
    expect(isUniqueViolation({ driverError: { code: '23505' } })).toBe(true);
  });

  it('recognizes better-sqlite3 constraint errors', () => {
    expect(isUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(true);
    expect(
      isUniqueViolation({ message: 'UNIQUE constraint failed: entities.userId' }),
    ).toBe(true);
  });

  it('rejects unrelated errors so they propagate', () => {
    expect(isUniqueViolation(new Error('connection lost'))).toBe(false);
    expect(isUniqueViolation({ driverError: { code: '42P01' } })).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });
});

describe('EntitiesRegistryService', () => {
  let dataSource: DataSource;
  let service: EntitiesRegistryService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    service = new EntitiesRegistryService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(VoiceProfileEntity),
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed a committed inbox item; return its id. */
  async function createItem(occurredAt = '2026-07-01T10:00:00Z'): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  /** Seed a succeeded `entities` extraction row; return its id. */
  async function createEntitiesExtraction(
    inboxItemId: string,
    createdAt: Date,
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'entities',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt,
    });
    return row.id;
  }

  async function createProfile(name: string | null): Promise<string> {
    const row = await dataSource.getRepository(VoiceProfileEntity).save({
      userId: USER,
      name,
      status: 'confirmed',
    });
    return row.id;
  }

  it('normalizes + dedupes a batch and unions aliases', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    const extracted: ExtractedEntity[] = [
      { type: 'person', name: 'Angela Merkel', mentions: ['Angela'] },
      { type: 'person', name: 'angela merkel', mentions: ['Frau Merkel'] },
      { type: 'organization', name: 'CDU', mentions: [] },
    ];

    const count = await service.ingest(USER, item, ext, extracted);

    // Two distinct entities: the two "Merkel" spellings collapse into one.
    expect(count).toBe(2);
    const list = await service.list(USER);
    const person = list.find((e) => e.type === 'person')!;
    expect(person.canonicalName).toBe('Angela Merkel');
    expect(person.aliases.sort()).toEqual(
      ['Angela', 'Angela Merkel', 'Frau Merkel', 'angela merkel'].sort(),
    );
    expect(person.mentionCount).toBe(1);
    expect(list.map((e) => e.type).sort()).toEqual(['organization', 'person']);
  });

  it('links a person entity to a voice profile with a matching name', async () => {
    const profileId = await createProfile('Angela Merkel');
    await createProfile('Someone Else');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'angela merkel', mentions: [] },
      { type: 'organization', name: 'Angela Merkel', mentions: [] }, // same name, not a person
    ]);

    const list = await service.list(USER);
    expect(list.find((e) => e.type === 'person')!.voiceProfileId).toBe(profileId);
    // Non-person entities never link to a profile.
    expect(list.find((e) => e.type === 'organization')!.voiceProfileId).toBeNull();
  });

  it('filters the list by type', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'Bob', mentions: [] },
      { type: 'place', name: 'Berlin', mentions: [] },
      { type: 'medication', name: 'Ibuprofen', mentions: [] },
    ]);

    const places = await service.list(USER, 'place');
    expect(places.map((e) => e.canonicalName)).toEqual(['Berlin']);
  });

  it('supersedes mentions from an older extraction on reprocessing', async () => {
    const item = await createItem();
    const older = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    const newer = await createEntitiesExtraction(item, new Date('2026-07-01T11:00:00Z'));

    await service.ingest(USER, item, older, [{ type: 'person', name: 'Old Name', mentions: [] }]);
    await service.ingest(USER, item, newer, [{ type: 'person', name: 'New Name', mentions: [] }]);

    // The default list hides the superseded ghost row entirely.
    expect((await service.list(USER)).map((e) => e.canonicalName)).toEqual(['New Name']);

    const list = await service.list(USER, undefined, true);
    const byName = new Map(list.map((e) => [e.canonicalName, e]));
    // Both registry rows persist (mutable registry), but only the latest
    // extraction's mentions count.
    expect(byName.get('New Name')!.mentionCount).toBe(1);
    expect(byName.get('Old Name')!.mentionCount).toBe(0);
  });

  it('counts distinct recordings across items', async () => {
    const item1 = await createItem('2026-07-01T10:00:00Z');
    const item2 = await createItem('2026-07-02T10:00:00Z');
    const ext1 = await createEntitiesExtraction(item1, new Date('2026-07-01T10:00:00Z'));
    const ext2 = await createEntitiesExtraction(item2, new Date('2026-07-02T10:00:00Z'));
    await service.ingest(USER, item1, ext1, [{ type: 'person', name: 'Bob', mentions: [] }]);
    await service.ingest(USER, item2, ext2, [{ type: 'person', name: 'bob', mentions: [] }]);

    const [bob] = await service.list(USER);
    expect(bob.mentionCount).toBe(2);
  });

  it('returns an entity with its mentions from detail()', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'place', name: 'Berlin', mentions: ['Berlin'] }]);

    const [entity] = await service.list(USER);
    const detail = await service.detail(USER, entity.id);
    expect(detail.mentions).toHaveLength(1);
    expect(detail.mentions[0]).toMatchObject({ inboxItemId: item, surfaceForm: 'Berlin' });
  });

  it('records the observed surface form on the mention, not the canonical name', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'Angela Merkel', mentions: ['Frau Merkel', 'Angela'] },
      { type: 'organization', name: 'CDU', mentions: [] }, // falls back to the name
    ]);

    const list = await service.list(USER);
    const person = await service.detail(USER, list.find((e) => e.type === 'person')!.id);
    expect(person.mentions[0].surfaceForm).toBe('Frau Merkel');
    const org = await service.detail(USER, list.find((e) => e.type === 'organization')!.id);
    expect(org.mentions[0].surfaceForm).toBe('CDU');
  });

  it('is idempotent when the same extraction ingests twice', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    const batch: ExtractedEntity[] = [{ type: 'person', name: 'Bob', mentions: [] }];
    await service.ingest(USER, item, ext, batch);
    await service.ingest(USER, item, ext, batch);

    const [bob] = await service.list(USER);
    expect(bob.mentionCount).toBe(1);
    expect(await dataSource.getRepository(EntityMentionEntity).count()).toBe(1);
  });

  it('throws NotFound for an unknown or foreign entity', async () => {
    await expect(
      service.detail(USER, '11111111-1111-1111-1111-111111111111'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityAliasEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  EntitySuppressionEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type { ExtractedEntity } from '@plaudern/contracts';
import { normalize } from './contact-matching';
import { EntitiesCorrectionService } from './entities-correction.service';
import { EntitiesRegistryService, isUniqueViolation } from './entities-registry.service';

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
  let corrections: EntitiesCorrectionService;

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
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
    corrections = new EntitiesCorrectionService(dataSource);
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
    // The canonical name (and its case variants) is redundant with the header,
    // so it is dropped from the displayed alias list — only distinct surface
    // forms remain.
    expect(person.aliases.sort()).toEqual(['Angela', 'Frau Merkel'].sort());
    expect(person.mentionCount).toBe(1);
    expect(list.map((e) => e.type).sort()).toEqual(['organization', 'person']);
  });

  it('drops pronouns and generic role nouns from surface forms, keeping real names', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [
      {
        type: 'person',
        name: 'Jan Jaap',
        mentions: ['Patient', 'Sie', 'Ihnen', 'Ihre', 'Ihrer', 'Ihrem', 'Jan', 'Jan Jaap'],
      },
    ]);

    const person = (await service.list(USER)).find((e) => e.type === 'person')!;
    // Grammar (pronouns/possessives) and the generic "Patient" are gone; only
    // real names survive, and the canonical name is not duplicated.
    expect(person.aliases.sort()).toEqual(['Jan'].sort());
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

  it('links a diacritic-transliterated exact name at ingest ("Mueller" ↔ "Müller")', async () => {
    const profileId = await createProfile('Detlef Müller');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'Detlef Mueller', mentions: [] },
    ]);

    const [detlef] = await service.list(USER);
    expect(detlef.voiceProfileId).toBe(profileId);
    expect(detlef.voiceProfileLinkOrigin).toBe('auto');
  });

  it('leaves non-exact names unlinked at ingest (the resolver owns fuzzy matching)', async () => {
    await createProfile('Detlef Müller');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Detlef', mentions: [] }]);

    const [detlef] = await service.list(USER);
    expect(detlef.voiceProfileId).toBeNull();
    expect(detlef.voiceProfileLinkOrigin).toBeNull();
  });

  it('links and unlinks manually; unlink suppresses auto-linking', async () => {
    const profileId = await createProfile('Angela Merkel');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Angela Merkel', mentions: [] }]);
    const [entity] = await service.list(USER);
    expect(entity.voiceProfileId).toBe(profileId);

    const unlinked = await service.unlinkContact(USER, entity.id);
    expect(unlinked.voiceProfileId).toBeNull();
    expect(unlinked.voiceProfileLinkOrigin).toBe('suppressed');

    // A re-ingest may not silently redo the user's unlink.
    const ext2 = await createEntitiesExtraction(item, new Date('2026-07-01T11:00:00Z'));
    await service.ingest(USER, item, ext2, [{ type: 'person', name: 'Angela Merkel', mentions: [] }]);
    expect((await service.detail(USER, entity.id)).voiceProfileId).toBeNull();

    // …but a manual link is always possible.
    const relinked = await service.linkContact(USER, entity.id, profileId);
    expect(relinked.voiceProfileId).toBe(profileId);
    expect(relinked.voiceProfileLinkOrigin).toBe('manual');
  });

  it('rejects linking a non-person entity or a foreign profile', async () => {
    const profileId = await createProfile('ACME');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'organization', name: 'ACME', mentions: [] }]);
    const [org] = await service.list(USER);

    await expect(service.linkContact(USER, org.id, profileId)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const foreign = await dataSource.getRepository(VoiceProfileEntity).save({
      userId: '00000000-0000-0000-0000-0000000000bb',
      name: 'Other Person',
      status: 'confirmed',
    });
    const ext2 = await createEntitiesExtraction(item, new Date('2026-07-01T11:00:00Z'));
    await service.ingest(USER, item, ext2, [
      { type: 'organization', name: 'ACME', mentions: [] },
      { type: 'person', name: 'Zoe', mentions: [] },
    ]);
    const zoe = (await service.list(USER)).find((e) => e.canonicalName === 'Zoe')!;
    await expect(service.linkContact(USER, zoe.id, foreign.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('converts a person entity into a new confirmed contact', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Detlef Müller', mentions: [] }]);
    const [entity] = await service.list(USER);

    const converted = await service.convertToContact(USER, entity.id);
    expect(converted.voiceProfileId).not.toBeNull();
    expect(converted.voiceProfileLinkOrigin).toBe('manual');
    expect(converted.voiceProfileName).toBe('Detlef Müller');

    const profile = await dataSource
      .getRepository(VoiceProfileEntity)
      .findOneByOrFail({ id: converted.voiceProfileId as string });
    expect(profile).toMatchObject({ userId: USER, name: 'Detlef Müller', status: 'confirmed' });

    // Converting twice (already linked) is rejected.
    await expect(service.convertToContact(USER, entity.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  // Rename/retype live in the transactional EntitiesCorrectionService (JJ-63);
  // these cover the registry-visible outcome via its read model.
  it('renames an entity (keeping the old name as alias) and rejects collisions', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'Detlef', mentions: [] },
      { type: 'person', name: 'Bob', mentions: [] },
    ]);
    const detlef = (await service.list(USER)).find((e) => e.canonicalName === 'Detlef')!;

    await corrections.update(USER, detlef.id, { canonicalName: 'Detlef Müller' });
    const renamed = await service.detail(USER, detlef.id);
    expect(renamed.canonicalName).toBe('Detlef Müller');
    expect(renamed.aliases).toContain('Detlef');

    await expect(
      corrections.update(USER, detlef.id, { canonicalName: 'Bob' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('drops the contact link when an entity is re-typed away from person', async () => {
    await createProfile('Angela Merkel');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Angela Merkel', mentions: [] }]);
    const [entity] = await service.list(USER);
    expect(entity.voiceProfileId).not.toBeNull();

    await corrections.update(USER, entity.id, { type: 'organization' });
    const retyped = await service.detail(USER, entity.id);
    expect(retyped.type).toBe('organization');
    expect(retyped.voiceProfileId).toBeNull();
    expect(retyped.voiceProfileLinkOrigin).toBeNull();
  });
});

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  SpeakerOccurrenceEntity,
  VoiceProfileEntity,
} from '@plaudern/persistence';
import type { ExtractedEntity } from '@plaudern/contracts';
import {
  EntitiesRegistryService,
  isUniqueViolation,
  normalize,
  resolveContactLink,
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
      dataSource.getRepository(SpeakerOccurrenceEntity),
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

  /** Seed a succeeded diarization + one speaker occurrence per given profile. */
  async function addSpeakers(inboxItemId: string, profileIds: string[]): Promise<void> {
    const extraction = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'diarization',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T09:00:00Z'),
    });
    const occurrences = dataSource.getRepository(SpeakerOccurrenceEntity);
    for (const [index, voiceProfileId] of profileIds.entries()) {
      await occurrences.save({
        inboxItemId,
        extractionId: extraction.id,
        voiceProfileId,
        label: `SPEAKER_0${index}`,
        speakingSeconds: 10,
        similarity: null,
      });
    }
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

  it('auto-links a first-name mention to the single partially-matching contact', async () => {
    const profileId = await createProfile('Detlef Müller');
    await createProfile('Someone Else');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Detlef', mentions: [] }]);

    const [detlef] = await service.list(USER);
    expect(detlef.voiceProfileId).toBe(profileId);
    expect(detlef.voiceProfileLinkOrigin).toBe('auto');
    expect(detlef.voiceProfileName).toBe('Detlef Müller');
  });

  it('disambiguates a partial match by who speaks in the recording', async () => {
    const mueller = await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const item = await createItem();
    await addSpeakers(item, [mueller]);
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Detlef', mentions: [] }]);

    const [detlef] = await service.list(USER);
    expect(detlef.voiceProfileId).toBe(mueller);
  });

  it('does not link an ambiguous partial match without speaker context', async () => {
    await createProfile('Detlef Müller');
    await createProfile('Detlef Schmidt');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));

    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Detlef', mentions: [] }]);

    const [detlef] = await service.list(USER);
    expect(detlef.voiceProfileId).toBeNull();
    expect(detlef.voiceProfileLinkOrigin).toBeNull();
  });

  it('sweeps unlinked people via autoLinkContacts once a contact is named', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Angela Merkel', mentions: [] }]);
    expect((await service.list(USER))[0].voiceProfileId).toBeNull();

    const profileId = await createProfile('Angela Merkel');
    expect(await service.autoLinkContacts(USER)).toBe(1);
    expect((await service.list(USER))[0].voiceProfileId).toBe(profileId);
    // A second sweep finds nothing new.
    expect(await service.autoLinkContacts(USER)).toBe(0);
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

    // Neither a sweep nor a re-ingest may silently redo the user's unlink.
    expect(await service.autoLinkContacts(USER)).toBe(0);
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

  it('renames an entity (keeping the old name as alias) and rejects collisions', async () => {
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [
      { type: 'person', name: 'Detlef', mentions: [] },
      { type: 'person', name: 'Bob', mentions: [] },
    ]);
    const detlef = (await service.list(USER)).find((e) => e.canonicalName === 'Detlef')!;

    const renamed = await service.update(USER, detlef.id, { canonicalName: 'Detlef Müller' });
    expect(renamed.canonicalName).toBe('Detlef Müller');
    expect(renamed.aliases).toContain('Detlef');

    await expect(
      service.update(USER, detlef.id, { canonicalName: 'Bob' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('drops the contact link when an entity is re-typed away from person', async () => {
    await createProfile('Angela Merkel');
    const item = await createItem();
    const ext = await createEntitiesExtraction(item, new Date('2026-07-01T10:00:00Z'));
    await service.ingest(USER, item, ext, [{ type: 'person', name: 'Angela Merkel', mentions: [] }]);
    const [entity] = await service.list(USER);
    expect(entity.voiceProfileId).not.toBeNull();

    const retyped = await service.update(USER, entity.id, { type: 'organization' });
    expect(retyped.type).toBe('organization');
    expect(retyped.voiceProfileId).toBeNull();
    expect(retyped.voiceProfileLinkOrigin).toBeNull();
  });
});

describe('resolveContactLink', () => {
  const contacts = [
    { id: 'mueller', normalized: 'detlef müller' },
    { id: 'schmidt', normalized: 'detlef schmidt' },
    { id: 'angela', normalized: 'angela' },
  ];

  it('prefers an exact name match', () => {
    expect(resolveContactLink(['detlef müller'], contacts, null)).toBe('mueller');
  });

  it('matches via aliases too', () => {
    expect(resolveContactLink(['detti', 'detlef müller'], contacts, null)).toBe('mueller');
  });

  it('links a unique token-prefix match in either direction', () => {
    expect(resolveContactLink(['angela merkel'], contacts, null)).toBe('angela');
    expect(resolveContactLink(['schmidt'], contacts, null)).toBeNull(); // suffix ≠ prefix
  });

  it('resolves ambiguous partials only with speaker context', () => {
    expect(resolveContactLink(['detlef'], contacts, null)).toBeNull();
    expect(resolveContactLink(['detlef'], contacts, new Set(['schmidt']))).toBe('schmidt');
    expect(resolveContactLink(['detlef'], contacts, new Set(['schmidt', 'mueller']))).toBeNull();
  });

  it('never partial-matches mid-token', () => {
    expect(resolveContactLink(['det'], contacts, null)).toBeNull();
  });
});

import { NotFoundException } from '@nestjs/common';
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
import { EntitiesRegistryService } from './entities-registry.service';
import { EntityReconciliationService } from './entity-reconciliation.service';

const USER = '00000000-0000-0000-0000-0000000000aa';

describe('EntityReconciliationService', () => {
  let dataSource: DataSource;
  let registry: EntitiesRegistryService;
  let reconciliation: EntityReconciliationService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    registry = new EntitiesRegistryService(
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(EntityMentionEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
      dataSource.getRepository(VoiceProfileEntity),
      dataSource.getRepository(EntityAliasEntity),
      dataSource.getRepository(EntitySuppressionEntity),
    );
    reconciliation = new EntityReconciliationService(registry);
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function ingest(extracted: ExtractedEntity[]): Promise<void> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const ext = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'entities',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt: new Date('2026-07-01T10:00:00Z'),
    });
    await registry.ingest(USER, item.id, ext.id, extracted);
  }

  async function idOf(type: string): Promise<string> {
    const row = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneOrFail({ where: { userId: USER, type: type as never } });
    return row.id;
  }

  it('surfaces an exact same-name entity of a DIFFERENT type', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Foo', mentions: ['Foo'] },
    ]);
    const productId = await idOf('product');

    const candidates = await reconciliation.findCandidates(USER, productId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toBe('exact-cross-type');
    expect(candidates[0].score).toBe(1);
    expect(candidates[0].candidate.type).toBe('organization');
    expect(candidates[0].candidate.canonicalName).toBe('Foo');
  });

  it('does NOT surface a same-name SAME-type entity (already deduped) or itself', async () => {
    await ingest([
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
      { type: 'product', name: 'Bar', mentions: ['Bar'] },
    ]);
    const orgId = await idOf('organization');

    const candidates = await reconciliation.findCandidates(USER, orgId);
    expect(candidates).toHaveLength(0);
  });

  it('surfaces fuzzy/similar names only when requested', async () => {
    await ingest([
      { type: 'organization', name: 'Foo GmbH', mentions: ['Foo GmbH'] },
      { type: 'organization', name: 'Foo', mentions: ['Foo'] },
    ]);
    const gmbh = await dataSource
      .getRepository(EntityRegistryEntity)
      .findOneOrFail({ where: { userId: USER, canonicalName: 'Foo GmbH' } });

    // Without fuzzy: nothing (different names, same type, no exact-cross-type).
    expect(await reconciliation.findCandidates(USER, gmbh.id)).toHaveLength(0);

    // With fuzzy: "Foo" is a token-subset of "Foo GmbH" → surfaced.
    const fuzzy = await reconciliation.findCandidates(USER, gmbh.id, { fuzzy: true });
    expect(fuzzy).toHaveLength(1);
    expect(fuzzy[0].reason).toBe('fuzzy');
    expect(fuzzy[0].candidate.canonicalName).toBe('Foo');
  });

  it('throws NotFound for an unknown entity', async () => {
    await expect(
      reconciliation.findCandidates(USER, '00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

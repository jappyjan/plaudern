import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  EntityRegistryEntity,
  EntityRelationEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
} from '@plaudern/persistence';
import type { ExtractedRelation } from '@plaudern/contracts';
import { normalize } from './entities-registry.service';
import { COOCCURRENCE_CONFIDENCE, EntityGraphService } from './entity-graph.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

describe('EntityGraphService', () => {
  let dataSource: DataSource;
  let service: EntityGraphService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    service = new EntityGraphService(
      dataSource.getRepository(EntityRelationEntity),
      dataSource.getRepository(EntityRegistryEntity),
      dataSource.getRepository(ExtractedPayloadEntity),
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

  /** Seed a succeeded `relations` extraction row; return its id. */
  async function createRelationsExtraction(
    inboxItemId: string,
    createdAt: Date,
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind: 'relations',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      createdAt,
    });
    return row.id;
  }

  /** Seed a registry entity; returns the full row (ingest needs id + names). */
  async function createEntity(
    name: string,
    type: EntityRegistryEntity['type'] = 'person',
    aliases: string[] = [],
    userId = USER,
  ): Promise<EntityRegistryEntity> {
    return dataSource.getRepository(EntityRegistryEntity).save({
      userId,
      type,
      canonicalName: name,
      normalizedName: normalize(name),
      aliases,
      voiceProfileId: null,
    });
  }

  /** Seed one item + succeeded relations extraction and ingest a batch. */
  async function ingestBatch(
    relations: ExtractedRelation[],
    entities: EntityRegistryEntity[],
    createdAt = new Date('2026-07-01T10:00:00Z'),
  ): Promise<{ itemId: string; extractionId: string; count: number }> {
    const itemId = await createItem(createdAt.toISOString());
    const extractionId = await createRelationsExtraction(itemId, createdAt);
    const count = await service.ingest(USER, itemId, extractionId, relations, entities);
    return { itemId, extractionId, count };
  }

  describe('ingest (validation + co-occurrence)', () => {
    it('drops relations whose endpoints do not resolve to this item\'s entities', async () => {
      const angela = await createEntity('Angela Merkel');
      const cdu = await createEntity('CDU', 'organization');
      const { count } = await ingestBatch(
        [
          { type: 'works_at', source: 'Angela Merkel', target: 'CDU' },
          // Invented entity — must never be written.
          { type: 'works_at', source: 'Angela Merkel', target: 'Nonexistent GmbH' },
          // Self-loop after resolution — dropped too.
          { type: 'related_to', source: 'Angela Merkel', target: 'angela merkel' },
        ],
        [angela, cdu],
      );

      // One explicit edge; the pair is now related, so no co-occurrence edge.
      expect(count).toBe(1);
      const rows = await dataSource.getRepository(EntityRelationEntity).find();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sourceEntityId: angela.id,
        targetEntityId: cdu.id,
        relationType: 'works_at',
        origin: 'llm',
      });
    });

    it('resolves endpoints via aliases, case-insensitively', async () => {
      const angela = await createEntity('Angela Merkel', 'person', ['Frau Merkel']);
      const cdu = await createEntity('CDU', 'organization');
      const { count } = await ingestBatch(
        [{ type: 'part_of', source: 'frau merkel', target: 'cdu', confidence: 0.9 }],
        [angela, cdu],
      );

      expect(count).toBe(1);
      const [row] = await dataSource.getRepository(EntityRelationEntity).find();
      expect(row).toMatchObject({
        sourceEntityId: angela.id,
        targetEntityId: cdu.id,
        relationType: 'part_of',
        confidence: 0.9,
      });
    });

    it('adds a weak co-occurrence edge for pairs the model did not relate', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const c = await createEntity('Contract X', 'document_reference');
      const { count } = await ingestBatch(
        [{ type: 'promised_to', source: 'Alice', target: 'Bob' }],
        [a, b, c],
      );

      // 1 explicit + 2 co-occurrence (a–c, b–c); the related pair is skipped.
      expect(count).toBe(3);
      const rows = await dataSource.getRepository(EntityRelationEntity).find();
      const implicit = rows.filter((r) => r.origin === 'cooccurrence');
      expect(implicit).toHaveLength(2);
      for (const row of implicit) {
        expect(row.relationType).toBe('related_to');
        expect(row.confidence).toBe(COOCCURRENCE_CONFIDENCE);
        expect(row.label).toBeNull();
      }
    });

    it('canonicalizes symmetric relations so A→B and B→A dedupe', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const { count } = await ingestBatch(
        [
          { type: 'discussed_with', source: 'Alice', target: 'Bob' },
          { type: 'discussed_with', source: 'Bob', target: 'Alice' },
        ],
        [a, b],
      );

      expect(count).toBe(1);
      expect(await dataSource.getRepository(EntityRelationEntity).count()).toBe(1);
    });

    it('is idempotent when the same extraction ingests twice', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const batch: ExtractedRelation[] = [{ type: 'owns', source: 'Alice', target: 'Bob' }];
      const { itemId, extractionId } = await ingestBatch(batch, [a, b]);
      await service.ingest(USER, itemId, extractionId, batch, [a, b]);

      expect(await dataSource.getRepository(EntityRelationEntity).count()).toBe(1);
    });
  });

  describe('edgesFor (aggregation + supersede)', () => {
    it('aggregates evidence across recordings into one edge', async () => {
      const a = await createEntity('Alice');
      const acme = await createEntity('ACME', 'organization');
      await ingestBatch(
        [{ type: 'works_at', source: 'Alice', target: 'ACME', confidence: 0.5 }],
        [a, acme],
        new Date('2026-07-01T10:00:00Z'),
      );
      await ingestBatch(
        [{ type: 'works_at', source: 'Alice', target: 'ACME', label: 'as CTO', confidence: 0.9 }],
        [a, acme],
        new Date('2026-07-02T10:00:00Z'),
      );

      const edges = await service.edgesFor(USER, a.id);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        sourceEntityId: a.id,
        targetEntityId: acme.id,
        relationType: 'works_at',
        label: 'as CTO',
        confidence: 0.9,
        origin: 'llm',
        evidenceCount: 2,
      });
    });

    it('supersedes evidence from an older extraction on reprocessing', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const itemId = await createItem();
      const older = await createRelationsExtraction(itemId, new Date('2026-07-01T10:00:00Z'));
      const newer = await createRelationsExtraction(itemId, new Date('2026-07-01T11:00:00Z'));
      await service.ingest(USER, itemId, older, [{ type: 'owns', source: 'Alice', target: 'Bob' }], [a, b]);
      await service.ingest(USER, itemId, newer, [{ type: 'promised_to', source: 'Alice', target: 'Bob' }], [a, b]);

      const edges = await service.edgesFor(USER, a.id);
      expect(edges).toHaveLength(1);
      expect(edges[0].relationType).toBe('promised_to');
    });

    it('filters by relation type', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const c = await createEntity('Carol');
      await ingestBatch([{ type: 'promised_to', source: 'Alice', target: 'Bob' }], [a, b, c]);

      const promised = await service.edgesFor(USER, a.id, 'promised_to');
      expect(promised).toHaveLength(1);
      expect(promised[0].relationType).toBe('promised_to');
      const related = await service.edgesFor(USER, a.id, 'related_to');
      expect(related).toHaveLength(1);
      expect(related[0].origin).toBe('cooccurrence');
    });
  });

  describe('neighborhood', () => {
    it('returns the entity, its edges and the connected entities', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const acme = await createEntity('ACME', 'organization');
      await ingestBatch(
        [
          { type: 'works_at', source: 'Alice', target: 'ACME' },
          { type: 'works_at', source: 'Bob', target: 'ACME' },
        ],
        [a, b, acme],
      );

      const hood = await service.neighborhood(USER, acme.id);
      expect(hood.entity).toEqual({ id: acme.id, type: 'organization', canonicalName: 'ACME' });
      expect(hood.relations).toHaveLength(2);
      expect(hood.neighbors.map((n) => n.canonicalName)).toEqual(['Alice', 'Bob']);
    });

    it('applies the relation-type filter to edges and neighbors alike', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const acme = await createEntity('ACME', 'organization');
      await ingestBatch(
        [{ type: 'works_at', source: 'Alice', target: 'ACME' }],
        [a, b, acme],
      );

      const hood = await service.neighborhood(USER, acme.id, 'works_at');
      expect(hood.relations).toHaveLength(1);
      expect(hood.neighbors.map((n) => n.canonicalName)).toEqual(['Alice']);
    });

    it('throws NotFound for an unknown or foreign entity', async () => {
      const foreign = await createEntity('Mallory', 'person', [], OTHER_USER);
      await expect(service.neighborhood(USER, foreign.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('connect', () => {
    it('finds the multi-hop subgraph connecting the requested entities', async () => {
      // landlord —(item1)— contract —(item2)— water damage
      const landlord = await createEntity('Herr Schmidt');
      const contract = await createEntity('Mietvertrag', 'document_reference');
      const damage = await createEntity('Wasserschaden', 'document_reference');
      await ingestBatch(
        [{ type: 'owns', source: 'Herr Schmidt', target: 'Mietvertrag' }],
        [landlord, contract],
        new Date('2026-07-01T10:00:00Z'),
      );
      await ingestBatch(
        [{ type: 'involved_in', source: 'Mietvertrag', target: 'Wasserschaden' }],
        [contract, damage],
        new Date('2026-07-02T10:00:00Z'),
      );

      const graph = await service.connect(USER, [landlord.id, damage.id], 3);
      expect(graph.connected).toBe(true);
      expect(graph.entities.map((e) => e.canonicalName).sort()).toEqual([
        'Herr Schmidt',
        'Mietvertrag',
        'Wasserschaden',
      ]);
      expect(graph.relations).toHaveLength(2);
    });

    it('reports connected=false when an entity is unreachable within maxDepth', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const island = await createEntity('Island');
      await ingestBatch([{ type: 'discussed_with', source: 'Alice', target: 'Bob' }], [a, b]);

      const graph = await service.connect(USER, [a.id, island.id], 3);
      expect(graph.connected).toBe(false);
      // The seeds themselves are still returned.
      expect(graph.entities.map((e) => e.canonicalName).sort()).toEqual(['Alice', 'Island']);
    });

    it('respects the depth bound', async () => {
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      const c = await createEntity('Carol');
      await ingestBatch(
        [{ type: 'discussed_with', source: 'Alice', target: 'Bob' }],
        [a, b],
        new Date('2026-07-01T10:00:00Z'),
      );
      await ingestBatch(
        [{ type: 'discussed_with', source: 'Bob', target: 'Carol' }],
        [b, c],
        new Date('2026-07-02T10:00:00Z'),
      );

      expect((await service.connect(USER, [a.id, c.id], 1)).connected).toBe(false);
      expect((await service.connect(USER, [a.id, c.id], 2)).connected).toBe(true);
    });

    it('throws NotFound when any requested entity belongs to another user', async () => {
      const a = await createEntity('Alice');
      const foreign = await createEntity('Mallory', 'person', [], OTHER_USER);
      await expect(service.connect(USER, [a.id, foreign.id], 3)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('never traverses another user\'s edges', async () => {
      // Same-id entities can't collide across users, but a shared entity id in
      // the frontier must not pull in the other user's evidence rows.
      const a = await createEntity('Alice');
      const b = await createEntity('Bob');
      // Foreign evidence directly between the two probed entities.
      const foreignItem = await dataSource.getRepository(InboxItemEntity).save({
        userId: OTHER_USER,
        deviceId: null,
        sourceType: 'plaud',
        occurredAt: '2026-07-01T10:00:00Z',
        idempotencyKey: `key-${Math.random()}`,
        metadata: null,
      });
      const foreignExtraction = await createRelationsExtraction(
        foreignItem.id,
        new Date('2026-07-01T10:00:00Z'),
      );
      await dataSource.getRepository(EntityRelationEntity).save({
        userId: OTHER_USER,
        inboxItemId: foreignItem.id,
        extractionId: foreignExtraction,
        sourceEntityId: a.id,
        targetEntityId: b.id,
        relationType: 'owns',
        label: null,
        confidence: null,
        origin: 'llm',
      });

      const graph = await service.connect(USER, [a.id, b.id], 3);
      expect(graph.connected).toBe(false);
      expect(graph.relations).toHaveLength(0);
    });
  });
});

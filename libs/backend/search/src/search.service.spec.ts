import { NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import {
  ALL_ENTITIES,
  EmbeddingChunkEntity,
  EntityMentionEntity,
  EntityRegistryEntity,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemSensitivityEntity,
  ItemTopicEntity,
} from '@plaudern/persistence';
import type { EmbeddingSearchHit } from '@plaudern/embeddings';
import { KeywordSearchService } from './keyword-search.service';
import { SearchService } from './search.service';

const USER = 'user-1';

interface FakeEmbeddingSearch {
  enabled: boolean;
  isEnabled: (userId: string) => Promise<boolean>;
  search: jest.Mock;
}

function semHit(inboxItemId: string, score: number): EmbeddingSearchHit {
  return {
    inboxItemId,
    chunkId: `chunk-${inboxItemId}`,
    source: 'transcript',
    text: `semantic chunk for ${inboxItemId}`,
    startSeconds: 1,
    endSeconds: 2,
    score,
  };
}

describe('SearchService', () => {
  let dataSource: DataSource;
  let items: Repository<InboxItemEntity>;
  let payloads: Repository<ExtractedPayloadEntity>;
  let mentions: Repository<EntityMentionEntity>;
  let registry: Repository<EntityRegistryEntity>;
  let itemTopics: Repository<ItemTopicEntity>;
  let chunks: Repository<EmbeddingChunkEntity>;
  let embedding: FakeEmbeddingSearch;
  let service: SearchService;

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    items = dataSource.getRepository(InboxItemEntity);
    payloads = dataSource.getRepository(ExtractedPayloadEntity);
    mentions = dataSource.getRepository(EntityMentionEntity);
    registry = dataSource.getRepository(EntityRegistryEntity);
    itemTopics = dataSource.getRepository(ItemTopicEntity);
    chunks = dataSource.getRepository(EmbeddingChunkEntity);
    const sensitivity = dataSource.getRepository(ItemSensitivityEntity);

    // `EmbeddingSearchService.isEnabled(userId)` is async now; back it by the
    // mutable `enabled` flag so individual tests can flip semantic off.
    embedding = { enabled: true, search: jest.fn(async () => []) } as FakeEmbeddingSearch;
    embedding.isEnabled = async () => embedding.enabled;
    const keyword = new KeywordSearchService(payloads, items);
    service = new SearchService(
      embedding as never,
      keyword,
      items,
      mentions,
      itemTopics,
      chunks,
      sensitivity,
    );
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function addItem(
    id: string,
    opts: {
      sourceType?: string;
      occurredAt?: string;
      transcript?: string;
      summaryTitle?: string;
      userId?: string;
    } = {},
  ): Promise<void> {
    await items.save(
      items.create({
        id,
        userId: opts.userId ?? USER,
        deviceId: null,
        sourceType: (opts.sourceType ?? 'audio') as never,
        occurredAt: opts.occurredAt ?? '2026-07-01T09:00:00.000Z',
        idempotencyKey: id,
        metadata: null,
      }),
    );
    if (opts.transcript !== undefined) {
      await payloads.save(
        payloads.create({
          inboxItemId: id,
          kind: 'transcription',
          provider: 'test',
          status: 'succeeded',
          content: opts.transcript,
        }),
      );
    }
    if (opts.summaryTitle) {
      await payloads.save(
        payloads.create({
          inboxItemId: id,
          kind: 'summary',
          provider: 'test',
          status: 'succeeded',
          content: JSON.stringify({
            title: opts.summaryTitle,
            layout: 'note',
            markdown: 'body',
          }),
        }),
      );
    }
  }

  async function addExtraction(itemId: string, kind: string): Promise<string> {
    const row = await payloads.save(
      payloads.create({
        inboxItemId: itemId,
        kind: kind as never,
        provider: 'test',
        status: 'succeeded',
        content: '{}',
      }),
    );
    return row.id;
  }

  async function tagEntity(itemId: string, entityId: string): Promise<void> {
    const extractionId = await addExtraction(itemId, 'entities');
    await mentions.save(
      mentions.create({ entityId, inboxItemId: itemId, extractionId, userId: USER, surfaceForm: 'x' }),
    );
  }

  async function addEntity(id: string, name: string): Promise<void> {
    await registry.save(
      registry.create({
        id,
        userId: USER,
        type: 'person' as never,
        canonicalName: name,
        normalizedName: name.toLowerCase(),
        aliases: [],
        voiceProfileId: null,
      }),
    );
  }

  async function tagTopic(itemId: string, topicId: string): Promise<void> {
    const extractionId = await addExtraction(itemId, 'topics');
    await itemTopics.save(
      itemTopics.create({
        inboxItemId: itemId,
        extractionId,
        userId: USER,
        topicId,
        name: 'Topic',
        confidence: 0.9,
      }),
    );
  }

  async function addChunks(
    itemId: string,
    vectors: number[][],
    text = 'chunk',
    userId = USER,
  ): Promise<void> {
    const extractionId = await addExtraction(itemId, 'embedding');
    let i = 0;
    for (const embeddingVec of vectors) {
      await chunks.save(
        chunks.create({
          extractionId,
          inboxItemId: itemId,
          userId,
          source: 'transcript',
          chunkIndex: i++,
          text,
          startSeconds: 0,
          endSeconds: 1,
          model: 'test',
          dimensions: embeddingVec.length,
          embedding: embeddingVec,
        }),
      );
    }
  }

  describe('graceful degradation', () => {
    it('runs keyword-only and marks semantic unavailable when embeddings are off', async () => {
      embedding.enabled = false;
      await addItem('a', { transcript: 'we agreed on the launch date' });
      await addItem('b', { transcript: 'unrelated cooking notes' });

      const res = await service.search(USER, { query: 'launch' });

      expect(res.legs.semantic).toBe('unavailable');
      expect(res.legs.keyword).toBe('ran');
      expect(res.legs.notes.join(' ')).toMatch(/embeddings provider not configured/);
      expect(res.results.map((r) => r.itemId)).toEqual(['a']);
      expect(embedding.search).not.toHaveBeenCalled();
      // Keyword snippet carries a highlight.
      expect(res.results[0].snippet).toContain('<mark>');
      expect(res.results[0].keywordScore).not.toBeNull();
      expect(res.results[0].semanticScore).toBeNull();
    });
  });

  describe('fusion', () => {
    it('fuses semantic + keyword with RRF; items in both legs rank top', async () => {
      await addItem('a', { transcript: 'budget budget planning' });
      await addItem('b', { transcript: 'budget budget budget review' });
      await addItem('c', { transcript: 'budget once' });
      embedding.search.mockResolvedValue([semHit('b', 0.9), semHit('a', 0.8)]);

      const res = await service.search(USER, { query: 'budget' });

      expect(res.legs.semantic).toBe('ran');
      expect(res.legs.keyword).toBe('ran');
      // b is rank 1 in both legs → top; a is second in both; c only keyword.
      expect(res.results.map((r) => r.itemId)).toEqual(['b', 'a', 'c']);

      const b = res.results[0];
      expect(b.semanticRank).toBe(1);
      expect(b.keywordRank).toBe(1);
      expect(b.semanticScore).toBe(0.9);
      expect(b.keywordScore).not.toBeNull();
      expect(b.fusedScore).toBeGreaterThan(res.results[1].fusedScore);

      const c = res.results[2];
      expect(c.semanticScore).toBeNull();
      expect(c.semanticRank).toBeNull();
      expect(c.keywordScore).not.toBeNull();
    });

    it('prefers the highlighted keyword snippet, falling back to semantic text', async () => {
      await addItem('a', { transcript: 'the quarterly budget meeting' });
      await addItem('sem', { transcript: 'nothing relevant here' });
      // "sem" only surfaces via the semantic leg (no keyword match for budget).
      embedding.search.mockResolvedValue([semHit('sem', 0.7), semHit('a', 0.6)]);

      const res = await service.search(USER, { query: 'budget' });
      const a = res.results.find((r) => r.itemId === 'a')!;
      const sem = res.results.find((r) => r.itemId === 'sem')!;
      expect(a.snippet).toContain('<mark>budget</mark>');
      expect(sem.snippet).toBe('semantic chunk for sem');
      expect(sem.startSeconds).toBe(1);
    });
  });

  describe('structured filters (apply to both legs)', () => {
    it('filters by sourceType', async () => {
      await addItem('a', { sourceType: 'audio', transcript: 'budget audio' });
      await addItem('c', { sourceType: 'text', transcript: 'budget text' });
      embedding.search.mockResolvedValue([semHit('c', 0.9), semHit('a', 0.8)]);

      const res = await service.search(USER, {
        query: 'budget',
        filters: { sourceType: 'audio' },
      });
      expect(res.results.map((r) => r.itemId)).toEqual(['a']);
    });

    it('filters by occurredAt date range (inclusive)', async () => {
      await addItem('old', { occurredAt: '2026-01-01T00:00:00.000Z', transcript: 'budget' });
      await addItem('mid', { occurredAt: '2026-06-15T00:00:00.000Z', transcript: 'budget' });
      await addItem('new', { occurredAt: '2026-12-31T00:00:00.000Z', transcript: 'budget' });

      const res = await service.search(USER, {
        query: 'budget',
        filters: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' },
      });
      expect(res.results.map((r) => r.itemId)).toEqual(['mid']);
    });

    it('filters by entityId', async () => {
      await addItem('a', { transcript: 'budget with anna' });
      await addItem('b', { transcript: 'budget alone' });
      await addEntity('ent-1', 'Anna');
      await tagEntity('a', 'ent-1');

      const res = await service.search(USER, {
        query: 'budget',
        filters: { entityId: 'ent-1' },
      });
      expect(res.results.map((r) => r.itemId)).toEqual(['a']);
    });

    it('filters by topicId', async () => {
      await addItem('a', { transcript: 'budget for hausbau' });
      await addItem('b', { transcript: 'budget for holiday' });
      await tagTopic('a', 'topic-1');

      const res = await service.search(USER, {
        query: 'budget',
        filters: { topicId: 'topic-1' },
      });
      expect(res.results.map((r) => r.itemId)).toEqual(['a']);
    });

    it('intersects multiple filters (AND)', async () => {
      await addItem('a', { sourceType: 'audio', transcript: 'budget' });
      await addItem('b', { sourceType: 'text', transcript: 'budget' });
      await tagTopic('a', 'topic-1');
      await tagTopic('b', 'topic-1');

      const res = await service.search(USER, {
        query: 'budget',
        filters: { sourceType: 'audio', topicId: 'topic-1' },
      });
      expect(res.results.map((r) => r.itemId)).toEqual(['a']);
    });

    it('returns empty (with a note) when filters match nothing', async () => {
      await addItem('a', { transcript: 'budget' });
      const res = await service.search(USER, {
        query: 'budget',
        filters: { entityId: 'nonexistent' },
      });
      expect(res.results).toEqual([]);
      expect(res.legs.notes.join(' ')).toMatch(/no items match/);
    });
  });

  describe('browse by filter (no query)', () => {
    it('returns filtered items newest-first with both legs skipped', async () => {
      await addItem('old', { sourceType: 'audio', occurredAt: '2026-01-01T00:00:00.000Z' });
      await addItem('new', { sourceType: 'audio', occurredAt: '2026-06-01T00:00:00.000Z' });
      await addItem('text', { sourceType: 'text', occurredAt: '2026-07-01T00:00:00.000Z' });

      const res = await service.search(USER, { filters: { sourceType: 'audio' } });
      expect(res.results.map((r) => r.itemId)).toEqual(['new', 'old']);
      expect(res.legs.semantic).toBe('skipped');
      expect(res.legs.keyword).toBe('skipped');
      expect(res.results[0].snippet).toBeNull();
      expect(embedding.search).not.toHaveBeenCalled();
    });
  });

  describe('similar (more like this)', () => {
    it('is unavailable when embeddings are not configured', async () => {
      embedding.enabled = false;
      await addItem('a', { transcript: 't' });
      const res = await service.similar(USER, 'a');
      expect(res.available).toBe(false);
      expect(res.results).toEqual([]);
      expect(res.reason).toMatch(/not configured/);
    });

    it('throws NotFound for an unknown or foreign item', async () => {
      await expect(service.similar(USER, 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('explains an item that has no embeddings yet', async () => {
      await addItem('a', { transcript: 't' });
      const res = await service.similar(USER, 'a');
      expect(res.available).toBe(true);
      expect(res.results).toEqual([]);
      expect(res.reason).toMatch(/no embeddings/);
    });

    it('ranks other items by centroid cosine similarity', async () => {
      await addItem('a', { transcript: 'source' });
      await addItem('near', { transcript: 'near' });
      await addItem('far', { transcript: 'far' });
      await addChunks('a', [[1, 0, 0]]);
      await addChunks('near', [[1, 0, 0]]);
      await addChunks('far', [[0, 1, 0]]);

      const res = await service.similar(USER, 'a');
      expect(res.available).toBe(true);
      expect(res.results.map((r) => r.itemId)).toEqual(['near', 'far']);
      expect(res.results[0].score).toBeGreaterThan(res.results[1].score);
      // The source item is never returned as its own neighbour.
      expect(res.results.map((r) => r.itemId)).not.toContain('a');
    });
  });

  describe('user isolation', () => {
    const OTHER = 'user-2';

    it('never returns another user\'s items from keyword search', async () => {
      await addItem('mine', { transcript: 'budget planning session' });
      await addItem('theirs', { transcript: 'budget planning session', userId: OTHER });
      embedding.enabled = false;

      const res = await service.search(USER, { query: 'budget' });
      expect(res.results.map((r) => r.itemId)).toEqual(['mine']);
    });

    it('never returns another user\'s items from filter-only browse', async () => {
      await addItem('mine', { sourceType: 'audio' });
      await addItem('theirs', { sourceType: 'audio', userId: OTHER });

      const res = await service.search(USER, { filters: { sourceType: 'audio' } });
      expect(res.results.map((r) => r.itemId)).toEqual(['mine']);
    });

    it('never returns another user\'s items from similar (vector path)', async () => {
      await addItem('mine', { transcript: 'source' });
      await addItem('mine-near', { transcript: 'near' });
      await addItem('theirs-near', { transcript: 'their near', userId: OTHER });
      await addChunks('mine', [[1, 0, 0]]);
      await addChunks('mine-near', [[1, 0, 0]]);
      // Identical vector, but owned by the other user — must never surface.
      await addChunks('theirs-near', [[1, 0, 0]], 'chunk', OTHER);

      const res = await service.similar(USER, 'mine');
      expect(res.results.map((r) => r.itemId)).toEqual(['mine-near']);
    });

    it('rejects similar() on another user\'s item id (no existence leak)', async () => {
      await addItem('theirs', { transcript: 't', userId: OTHER });
      await expect(service.similar(USER, 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

import { BadRequestException } from '@nestjs/common';
import type { EmbeddingChunkEntity } from '@plaudern/persistence';
import { EmbeddingSearchService } from './embedding.search';
import type { EmbeddingProvider } from './embedding.provider';

function chunk(over: Partial<EmbeddingChunkEntity>): EmbeddingChunkEntity {
  return {
    id: over.id ?? 'c1',
    inboxItemId: over.inboxItemId ?? 'item-1',
    userId: over.userId ?? 'user-1',
    source: over.source ?? 'transcript',
    chunkIndex: over.chunkIndex ?? 0,
    text: over.text ?? 'text',
    startSeconds: over.startSeconds ?? null,
    endSeconds: over.endSeconds ?? null,
    embedding: over.embedding ?? [1, 0, 0],
  } as unknown as EmbeddingChunkEntity;
}

function build(opts: { enabled?: boolean; queryVector?: number[]; rows?: EmbeddingChunkEntity[] }) {
  const provider: EmbeddingProvider = {
    id: 'fake',
    enabled: opts.enabled ?? true,
    dimensions: 3,
    embed: jest.fn(async () => ({
      vectors: [opts.queryVector ?? [1, 0, 0]],
      model: 'fake',
      dimensions: 3,
    })),
  };
  const find = jest.fn(async () => opts.rows ?? []);
  const repo = {
    find,
    manager: { connection: { options: { type: 'better-sqlite3' } } },
  };
  const service = new EmbeddingSearchService(provider, repo as never);
  return { service, provider, find };
}

describe('EmbeddingSearchService (in-memory cosine path)', () => {
  it('throws when embeddings are not configured', async () => {
    const { service } = build({ enabled: false });
    await expect(service.search('user-1', 'hello', 5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an empty query', async () => {
    const { service } = build({});
    await expect(service.search('user-1', '   ', 5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('ranks chunks by cosine similarity, closest first', async () => {
    const { service } = build({
      queryVector: [1, 0, 0],
      rows: [
        chunk({ id: 'far', inboxItemId: 'item-far', embedding: [0, 1, 0] }),
        chunk({ id: 'near', inboxItemId: 'item-near', embedding: [1, 0, 0] }),
        chunk({ id: 'mid', inboxItemId: 'item-mid', embedding: [1, 1, 0] }),
      ],
    });

    const hits = await service.search('user-1', 'query', 5);

    expect(hits.map((h) => h.inboxItemId)).toEqual(['item-near', 'item-mid', 'item-far']);
    expect(hits[0].score).toBeCloseTo(1, 5);
    expect(hits[0].chunkId).toBe('near');
  });

  it('collapses to the best chunk per item and honors the limit', async () => {
    const { service } = build({
      queryVector: [1, 0, 0],
      rows: [
        chunk({ id: 'a-weak', inboxItemId: 'item-a', embedding: [1, 1, 0] }),
        chunk({ id: 'a-strong', inboxItemId: 'item-a', embedding: [1, 0, 0] }),
        chunk({ id: 'b', inboxItemId: 'item-b', embedding: [1, 1, 0] }),
      ],
    });

    const hits = await service.search('user-1', 'query', 1);

    expect(hits).toHaveLength(1);
    expect(hits[0].inboxItemId).toBe('item-a');
    expect(hits[0].chunkId).toBe('a-strong');
  });

  it('skips chunks whose dimensions do not match the query vector', async () => {
    const { service } = build({
      queryVector: [1, 0, 0],
      rows: [chunk({ id: 'mismatch', embedding: [1, 0] })],
    });
    expect(await service.search('user-1', 'query', 5)).toEqual([]);
  });

  it('scopes the repository query to the acting user', async () => {
    const { service, find } = build({ rows: [] });
    await service.search('user-42', 'query', 5);
    expect(find).toHaveBeenCalledWith({ where: { userId: 'user-42' } });
  });
});

describe('EmbeddingSearchService.itemCentroids (JJ-64)', () => {
  it('returns nothing for an empty id list without querying', async () => {
    const { service, find } = build({ rows: [] });
    expect(await service.itemCentroids('user-1', [])).toEqual([]);
    expect(find).not.toHaveBeenCalled();
  });

  it('averages each item\'s chunk vectors into one centroid', async () => {
    const { service } = build({
      rows: [
        chunk({ id: 'a1', inboxItemId: 'item-a', embedding: [1, 0, 0] }),
        chunk({ id: 'a2', inboxItemId: 'item-a', embedding: [0, 1, 0] }),
        chunk({ id: 'b1', inboxItemId: 'item-b', embedding: [0, 0, 2] }),
      ],
    });
    const centroids = await service.itemCentroids('user-1', ['item-a', 'item-b']);
    const byId = new Map(centroids.map((c) => [c.inboxItemId, c.vector]));
    expect(byId.get('item-a')).toEqual([0.5, 0.5, 0]);
    expect(byId.get('item-b')).toEqual([0, 0, 2]);
  });

  it('skips chunks whose dimension differs from the item\'s first chunk', async () => {
    const { service } = build({
      rows: [
        chunk({ id: 'a1', inboxItemId: 'item-a', embedding: [2, 0, 0] }),
        chunk({ id: 'a2', inboxItemId: 'item-a', embedding: [1, 1] }),
      ],
    });
    const centroids = await service.itemCentroids('user-1', ['item-a']);
    expect(centroids).toEqual([{ inboxItemId: 'item-a', vector: [2, 0, 0] }]);
  });
});

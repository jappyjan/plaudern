import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicDocumentEntity,
  TopicEntity,
} from '@plaudern/persistence';
import { TopicDocumentService } from './topic-document.service';
import type { TopicDocumentProvider } from './topic-document.provider';
import type { TopicDocumentJob, TopicDocumentQueue } from './topic-document.job';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';

/** ConfigService stub that always returns the provided default (debounce = 0). */
function fakeConfig(overrides: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => overrides[key] ?? def,
  } as unknown as ConfigService;
}

function fakeProvider(enabled = true): TopicDocumentProvider {
  return {
    id: 'test:docs',
    enabled,
    generate: async () => ({ markdown: '## Overview\nStub.', model: 'test-model' }),
  };
}

describe('TopicDocumentService', () => {
  let dataSource: DataSource;
  let enqueued: TopicDocumentJob[];

  function build(provider: TopicDocumentProvider = fakeProvider()): TopicDocumentService {
    const queue: TopicDocumentQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
      },
    };
    return new TopicDocumentService(
      fakeConfig({ TOPIC_DOCS_DEBOUNCE_MS: '0' }),
      provider,
      queue,
      dataSource.getRepository(TopicEntity),
      dataSource.getRepository(TopicDocumentEntity),
      dataSource.getRepository(ItemTopicEntity),
    );
  }

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    enqueued = [];
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  async function createTopic(name = 'Hausbau', userId = USER, archived = false): Promise<string> {
    const row = await dataSource
      .getRepository(TopicEntity)
      .save({ userId, name, description: null, archived });
    return row.id;
  }

  /** Seed an item classified into a topic; returns the item id. */
  async function classifyItem(
    topicId: string,
    userId = USER,
    occurredAt = '2026-07-01T10:00:00Z',
  ): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const extraction = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'topics',
      version: 1,
      provider: 'test',
      status: 'succeeded',
    });
    await dataSource.getRepository(ItemTopicEntity).save({
      extractionId: extraction.id,
      inboxItemId: item.id,
      userId,
      topicId,
      name: 'Hausbau',
      confidence: 0.9,
    });
    return item.id;
  }

  function docs() {
    return dataSource.getRepository(TopicDocumentEntity);
  }

  it('is disabled when the provider is not configured, and enqueues nothing', async () => {
    const service = build(fakeProvider(false));
    expect(service.enabled).toBe(false);
    const id = await service.enqueueRegeneration(USER, await createTopic());
    expect(id).toBeNull();
    expect(enqueued).toHaveLength(0);
    expect(await docs().count()).toBe(0);
  });

  it('appends a queued v1 row and enqueues a job', async () => {
    const service = build();
    const topicId = await createTopic();
    const id = await service.enqueueRegeneration(USER, topicId);
    expect(id).not.toBeNull();
    expect(enqueued).toEqual([{ documentId: id, topicId, userId: USER }]);
    const row = await docs().findOneByOrFail({ id: id! });
    expect(row).toMatchObject({ topicId, version: 1, status: 'queued' });
  });

  it('coalesces while a generation is still queued (no second row)', async () => {
    const service = build();
    const topicId = await createTopic();
    const first = await service.enqueueRegeneration(USER, topicId);
    const second = await service.enqueueRegeneration(USER, topicId);
    expect(second).toBe(first);
    expect(await docs().count()).toBe(1);
    expect(enqueued).toHaveLength(1);
  });

  it('increments the version once the prior generation has settled', async () => {
    const service = build();
    const topicId = await createTopic();
    const first = await service.enqueueRegeneration(USER, topicId);
    await docs().update({ id: first! }, { status: 'succeeded', markdown: '## Overview\nv1' });
    const second = await service.enqueueRegeneration(USER, topicId);
    expect(second).not.toBe(first);
    const row = await docs().findOneByOrFail({ id: second! });
    expect(row.version).toBe(2);
  });

  it('onTopicsAssigned schedules a regeneration that flushes to an enqueue', async () => {
    const service = build();
    const topicId = await createTopic();
    service.onTopicsAssigned(USER, [topicId, topicId]);
    await service.flushPending();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].topicId).toBe(topicId);
  });

  it('getDocument shows the latest succeeded body plus the newest attempt status', async () => {
    const service = build();
    const topicId = await createTopic();
    const v1 = await service.enqueueRegeneration(USER, topicId);
    await docs().update(
      { id: v1! },
      { status: 'succeeded', markdown: '## Overview\nDone [1]', sourceItemCount: 1, model: 'm' },
    );
    // A newer attempt fails — the good body must stay visible.
    await docs().save(
      docs().create({ userId: USER, topicId, version: 2, status: 'failed', error: 'boom' }),
    );

    const doc = await service.getDocument(USER, topicId);
    expect(doc).toMatchObject({
      topicId,
      status: 'failed',
      version: 1,
      markdown: '## Overview\nDone [1]',
      error: 'boom',
      enabled: true,
    });
  });

  it('getDocument 404s for a topic the user does not own', async () => {
    const service = build();
    const topicId = await createTopic('Hausbau', OTHER);
    await expect(service.getDocument(USER, topicId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists and fetches succeeded versions', async () => {
    const service = build();
    const topicId = await createTopic();
    const v1 = await service.enqueueRegeneration(USER, topicId);
    await docs().update({ id: v1! }, { status: 'succeeded', markdown: '## v1', sourceItemCount: 1 });
    const list = await service.listVersions(USER, topicId);
    expect(list.versions).toHaveLength(1);
    expect(list.versions[0]).toMatchObject({ version: 1, sourceItemCount: 1 });
    const detail = await service.getVersion(USER, topicId, 1);
    expect(detail.markdown).toBe('## v1');
    await expect(service.getVersion(USER, topicId, 99)).rejects.toBeInstanceOf(NotFoundException);
  });

  describe('regenerate (manual)', () => {
    it('rejects when the feature is disabled', async () => {
      const service = build(fakeProvider(false));
      await expect(service.regenerate(USER, await createTopic())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('404s for an unknown topic', async () => {
      const service = build();
      await expect(
        service.regenerate(USER, '00000000-0000-0000-0000-0000000000ff'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a topic with no classified items', async () => {
      const service = build();
      await expect(service.regenerate(USER, await createTopic())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('enqueues for a topic that has items', async () => {
      const service = build();
      const topicId = await createTopic();
      await classifyItem(topicId);
      const id = await service.regenerate(USER, topicId);
      expect(id).not.toBeNull();
      expect(enqueued).toHaveLength(1);
    });
  });

  describe('backfill support', () => {
    it('reports topics whose document is missing or stale, skipping archived', async () => {
      const service = build();
      // Missing: has items, no document → needs generation.
      const missing = await createTopic('Missing');
      await classifyItem(missing, USER, '2026-06-01T10:00:00Z');

      // Stale: a document exists but predates the classification (staleness is
      // measured against item_topics.createdAt, i.e. when the item was tagged).
      const stale = await createTopic('Stale');
      await classifyItem(stale, USER, '2026-06-01T10:00:00Z');
      await docs().save(
        docs().create({
          userId: USER,
          topicId: stale,
          version: 1,
          status: 'succeeded',
          markdown: '## old',
          createdAt: new Date('2020-01-01T00:00:00Z'),
        }),
      );

      // Up to date: the document was generated after the item was tagged.
      const upToDate = await createTopic('UpToDate');
      await classifyItem(upToDate, USER, '2026-06-01T10:00:00Z');
      await docs().save(
        docs().create({
          userId: USER,
          topicId: upToDate,
          version: 1,
          status: 'succeeded',
          markdown: '## ok',
          createdAt: new Date('2030-01-01T00:00:00Z'),
        }),
      );

      const archived = await createTopic('Archived', USER, true);
      await classifyItem(archived);

      const targets = await service.topicsNeedingRegeneration();
      const topicIds = targets.map((t) => t.topicId);
      expect(topicIds).toContain(missing);
      expect(topicIds).toContain(stale);
      expect(topicIds).not.toContain(upToDate);
      expect(topicIds).not.toContain(archived);
    });

    it('prunes documents whose topic no longer exists', async () => {
      const service = build();
      const topicId = await createTopic();
      const id = await service.enqueueRegeneration(USER, topicId);
      await docs().update({ id: id! }, { status: 'succeeded', markdown: '## x' });
      await dataSource.getRepository(TopicEntity).delete({ id: topicId });

      const pruned = await service.pruneOrphans();
      expect(pruned).toBe(1);
      expect(await docs().count()).toBe(0);
    });
  });
});

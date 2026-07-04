import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import type { ExtractionKind, TopicAssignmentDto } from '@plaudern/contracts';
import type { TopicClassificationProvider } from './topics.provider';
import type { TopicsJob, TopicsQueue } from './topics.job';
import { TopicsService, TOPICS_EXTRACTOR_VERSION } from './topics.service';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

/**
 * Minimal InboxService stand-in backed by the same sqlite repositories — the
 * service only calls getItem (user-scoped read) and addExtraction (append).
 */
function fakeInbox(dataSource: DataSource): InboxService {
  const items = dataSource.getRepository(InboxItemEntity);
  const extractions = dataSource.getRepository(ExtractedPayloadEntity);
  return {
    async getItem(userId: string, id: string) {
      const item = await items.findOne({
        where: { id, userId },
        relations: { source: true, extractions: true },
      });
      if (!item) throw new NotFoundException('inbox item not found');
      return item;
    },
    async addExtraction(inboxItemId: string, kind: ExtractionKind, provider: string, version: number) {
      return extractions.save({ inboxItemId, kind, version, provider, status: 'queued' });
    },
  } as unknown as InboxService;
}

function fakeProvider(enabled = true): TopicClassificationProvider {
  return {
    id: 'test:classifier',
    enabled,
    classify: async () => ({ assignments: [] }),
  };
}

describe('TopicsService', () => {
  let dataSource: DataSource;
  let service: TopicsService;
  let enqueued: TopicsJob[];

  function buildService(provider: TopicClassificationProvider = fakeProvider()): TopicsService {
    const queue: TopicsQueue = {
      enqueue: async (job) => {
        enqueued.push(job);
      },
    };
    return new TopicsService(
      fakeInbox(dataSource),
      dataSource.getRepository(TopicEntity),
      dataSource.getRepository(ItemTopicEntity),
      dataSource.getRepository(InboxItemEntity),
      provider,
      queue,
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
    service = buildService();
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed a committed inbox item; return its id. */
  async function createItem(
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
    return item.id;
  }

  /** Seed an extraction row of the given kind; return its id. */
  async function createExtraction(
    inboxItemId: string,
    kind: ExtractedPayloadEntity['kind'],
    status: ExtractedPayloadEntity['status'],
    createdAt: Date,
    content: string | null = null,
  ): Promise<string> {
    const row = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId,
      kind,
      version: 1,
      provider: 'test',
      status,
      createdAt,
      content,
    });
    return row.id;
  }

  function topicsPayload(assignments: TopicAssignmentDto[], model = 'test-model'): string {
    return JSON.stringify({ model, assignments });
  }

  describe('taxonomy CRUD', () => {
    it('creates, lists, updates and archives a topic', async () => {
      const created = await service.createTopic(USER, {
        name: 'Hausbau',
        description: 'Building our house',
      });
      expect(created).toMatchObject({
        name: 'Hausbau',
        description: 'Building our house',
        archived: false,
      });

      const updated = await service.updateTopic(USER, created.id, {
        name: 'Haus',
        description: null,
        archived: true,
      });
      expect(updated).toMatchObject({ id: created.id, name: 'Haus', description: null, archived: true });

      const list = await service.listTopics(USER);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: created.id, archived: true });
    });

    it('only lists the calling user\'s topics', async () => {
      await service.createTopic(USER, { name: 'Mine' });
      await service.createTopic(OTHER_USER, { name: 'Theirs' });

      expect((await service.listTopics(USER)).map((t) => t.name)).toEqual(['Mine']);
      expect((await service.listTopics(OTHER_USER)).map((t) => t.name)).toEqual(['Theirs']);
    });

    it('rejects updating or deleting a foreign user\'s topic with NotFound', async () => {
      const theirs = await service.createTopic(OTHER_USER, { name: 'Theirs' });

      await expect(service.updateTopic(USER, theirs.id, { name: 'Hijacked' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(service.deleteTopic(USER, theirs.id)).rejects.toBeInstanceOf(NotFoundException);
      // The row is untouched.
      expect((await service.listTopics(OTHER_USER))[0]).toMatchObject({ name: 'Theirs' });
    });

    it('deleteTopic prunes the topic\'s item_topics assignments', async () => {
      const topic = await service.createTopic(USER, { name: 'Hausbau' });
      const keep = await service.createTopic(USER, { name: 'Work' });
      const item = await createItem();
      const ext = await createExtraction(item, 'topics', 'succeeded', new Date());
      await dataSource.getRepository(ItemTopicEntity).save([
        { extractionId: ext, inboxItemId: item, userId: USER, topicId: topic.id, name: 'Hausbau', confidence: 0.9 },
        { extractionId: ext, inboxItemId: item, userId: USER, topicId: keep.id, name: 'Work', confidence: 0.4 },
      ]);

      await service.deleteTopic(USER, topic.id);

      expect(await service.listTopics(USER)).toHaveLength(1);
      const remaining = await dataSource.getRepository(ItemTopicEntity).find();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].topicId).toBe(keep.id);
    });

    it('getActiveTopics excludes archived entries', async () => {
      const active = await service.createTopic(USER, { name: 'Active' });
      const archived = await service.createTopic(USER, { name: 'Old' });
      await service.updateTopic(USER, archived.id, { archived: true });

      const candidates = await service.getActiveTopics(USER);
      expect(candidates.map((t) => t.id)).toEqual([active.id]);
    });
  });

  describe('getItemTopics', () => {
    it('returns the latest classification\'s assignments and provenance', async () => {
      const topic = await service.createTopic(USER, { name: 'Hausbau' });
      const item = await createItem();
      await createExtraction(
        item,
        'topics',
        'succeeded',
        new Date('2026-07-01T10:00:00Z'),
        topicsPayload([{ topicId: topic.id, name: 'Hausbau', confidence: 0.9 }]),
      );

      const result = await service.getItemTopics(USER, item);
      expect(result.status).toBe('succeeded');
      expect(result.model).toBe('test-model');
      expect(result.assignments).toEqual([{ topicId: topic.id, name: 'Hausbau', confidence: 0.9 }]);
    });

    it('returns a null-status empty read model when the item was never classified', async () => {
      const item = await createItem();
      const result = await service.getItemTopics(USER, item);
      expect(result).toEqual({
        status: null,
        assignments: [],
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
      });
    });

    it('rejects a foreign user\'s item with NotFound', async () => {
      const item = await createItem(OTHER_USER);
      await expect(service.getItemTopics(USER, item)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('drops assignments of deleted topics so it agrees with listItemsByTopic', async () => {
      const kept = await service.createTopic(USER, { name: 'Work' });
      const doomed = await service.createTopic(USER, { name: 'Hausbau' });
      const item = await createItem();
      const ext = await createExtraction(
        item,
        'topics',
        'succeeded',
        new Date('2026-07-01T10:00:00Z'),
        topicsPayload([
          { topicId: kept.id, name: 'Work', confidence: 0.4 },
          { topicId: doomed.id, name: 'Hausbau', confidence: 0.9 },
        ]),
      );
      await dataSource.getRepository(ItemTopicEntity).save([
        { extractionId: ext, inboxItemId: item, userId: USER, topicId: kept.id, name: 'Work', confidence: 0.4 },
        { extractionId: ext, inboxItemId: item, userId: USER, topicId: doomed.id, name: 'Hausbau', confidence: 0.9 },
      ]);

      await service.deleteTopic(USER, doomed.id);

      const result = await service.getItemTopics(USER, item);
      expect(result.assignments).toEqual([{ topicId: kept.id, name: 'Work', confidence: 0.4 }]);
      // The other read model agrees: the surviving topic still lists the item...
      expect((await service.listItemsByTopic(USER, kept.id)).items).toHaveLength(1);
      // ...and the deleted topic is gone entirely.
      await expect(service.listItemsByTopic(USER, doomed.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listItemsByTopic', () => {
    it('lists the tagged items newest first, scoped to the user', async () => {
      const topic = await service.createTopic(USER, { name: 'Hausbau' });
      const older = await createItem(USER, '2026-07-01T10:00:00Z');
      const newer = await createItem(USER, '2026-07-02T10:00:00Z');
      const foreign = await createItem(OTHER_USER, '2026-07-03T10:00:00Z');
      const ext1 = await createExtraction(older, 'topics', 'succeeded', new Date());
      const ext2 = await createExtraction(newer, 'topics', 'succeeded', new Date());
      const ext3 = await createExtraction(foreign, 'topics', 'succeeded', new Date());
      await dataSource.getRepository(ItemTopicEntity).save([
        { extractionId: ext1, inboxItemId: older, userId: USER, topicId: topic.id, name: 'Hausbau', confidence: 0.7 },
        { extractionId: ext2, inboxItemId: newer, userId: USER, topicId: topic.id, name: 'Hausbau', confidence: 0.8 },
        // A (hypothetical) foreign row with the same topic id must never leak.
        { extractionId: ext3, inboxItemId: foreign, userId: OTHER_USER, topicId: topic.id, name: 'Hausbau', confidence: 0.9 },
      ]);

      const result = await service.listItemsByTopic(USER, topic.id);
      expect(result.items.map((i) => i.inboxItemId)).toEqual([newer, older]);
      expect(result.items[0].confidence).toBe(0.8);
    });

    it('rejects a foreign user\'s topic with NotFound', async () => {
      const theirs = await service.createTopic(OTHER_USER, { name: 'Theirs' });
      await expect(service.listItemsByTopic(USER, theirs.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('retry', () => {
    it('appends a fresh queued topics row and enqueues the job', async () => {
      const item = await createItem();
      await createExtraction(item, 'transcription', 'succeeded', new Date(), 'transcript text');

      const extractionId = await service.retry(USER, item);

      expect(enqueued).toEqual([{ extractionId, inboxItemId: item }]);
      const row = await dataSource
        .getRepository(ExtractedPayloadEntity)
        .findOneByOrFail({ id: extractionId });
      expect(row).toMatchObject({
        kind: 'topics',
        status: 'queued',
        provider: 'test:classifier',
        version: TOPICS_EXTRACTOR_VERSION,
      });
    });

    it('rejects when classification is not configured', async () => {
      service = buildService(fakeProvider(false));
      const item = await createItem();
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when the item has nothing to classify', async () => {
      const item = await createItem();
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects while a classification is already in flight', async () => {
      const item = await createItem();
      await createExtraction(item, 'transcription', 'succeeded', new Date('2026-07-01T10:00:00Z'), 'text');
      await createExtraction(item, 'topics', 'processing', new Date('2026-07-01T10:05:00Z'));
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rejects a foreign user\'s item with NotFound', async () => {
      const item = await createItem(OTHER_USER);
      await createExtraction(item, 'transcription', 'succeeded', new Date(), 'text');
      await expect(service.retry(USER, item)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

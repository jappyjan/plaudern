import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import { topicClassificationPayloadSchema } from '@plaudern/contracts';
import type {
  TopicClassificationInput,
  TopicClassificationProvider,
  TopicClassificationResult,
} from './topics.provider';
import { TopicsProcessor } from './topics.processor';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

/**
 * Minimal InboxService stand-in backed by the same sqlite repositories — the
 * processor only calls setExtractionStatus, getItemById and completeExtraction.
 */
function fakeInbox(dataSource: DataSource): InboxService {
  const items = dataSource.getRepository(InboxItemEntity);
  const extractions = dataSource.getRepository(ExtractedPayloadEntity);
  return {
    async setExtractionStatus(id: string, status: string) {
      await extractions.update({ id }, { status: status as ExtractedPayloadEntity['status'] });
    },
    async getItemById(id: string) {
      return items.findOne({ where: { id }, relations: { source: true, extractions: true } });
    },
    async completeExtraction(
      id: string,
      result: { status: 'succeeded' | 'failed'; content?: string; error?: string },
    ) {
      await extractions.update(
        { id },
        {
          status: result.status,
          content: result.content ?? null,
          error: result.error ?? null,
          completedAt: new Date().toISOString(),
        },
      );
    },
  } as unknown as InboxService;
}

/** Programmable provider fake that records every classify() call. */
function fakeProvider(
  respond: (input: TopicClassificationInput) => TopicClassificationResult,
): TopicClassificationProvider & { calls: TopicClassificationInput[] } {
  const calls: TopicClassificationInput[] = [];
  return {
    id: 'test:classifier',
    calls,
    classify: async (_userId: string, input: TopicClassificationInput) => {
      calls.push(input);
      return respond(input);
    },
  };
}

describe('TopicsProcessor', () => {
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

  function buildProcessor(provider: TopicClassificationProvider): TopicsProcessor {
    return new TopicsProcessor(
      fakeInbox(dataSource),
      provider,
      dataSource.getRepository(TopicEntity),
      dataSource.getRepository(ItemTopicEntity),
    );
  }

  async function createItem(userId = USER): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    return item.id;
  }

  async function createTopic(name: string, userId = USER, archived = false): Promise<string> {
    const row = await dataSource
      .getRepository(TopicEntity)
      .save({ userId, name, description: null, archived });
    return row.id;
  }

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

  /** Seed an item with a succeeded transcription plus a queued topics row. */
  async function seedJob(userId = USER): Promise<{ inboxItemId: string; extractionId: string }> {
    const inboxItemId = await createItem(userId);
    await createExtraction(
      inboxItemId,
      'transcription',
      'succeeded',
      new Date('2026-07-01T10:00:00Z'),
      'We poured the foundation for the new house.',
    );
    const extractionId = await createExtraction(
      inboxItemId,
      'topics',
      'queued',
      new Date('2026-07-01T10:05:00Z'),
    );
    return { inboxItemId, extractionId };
  }

  async function extractionRow(id: string): Promise<ExtractedPayloadEntity> {
    return dataSource.getRepository(ExtractedPayloadEntity).findOneByOrFail({ id });
  }

  it('persists the provider\'s assignments to the payload and the projection', async () => {
    const hausbau = await createTopic('Hausbau');
    await createTopic('Work');
    const { inboxItemId, extractionId } = await seedJob();
    const provider = fakeProvider(() => ({
      assignments: [{ topicId: hausbau, confidence: 0.9 }],
      model: 'test-model',
    }));

    await buildProcessor(provider).process({ extractionId, inboxItemId });

    const row = await extractionRow(extractionId);
    expect(row.status).toBe('succeeded');
    const payload = topicClassificationPayloadSchema.parse(JSON.parse(row.content!));
    expect(payload).toEqual({
      model: 'test-model',
      assignments: [{ topicId: hausbau, name: 'Hausbau', confidence: 0.9 }],
    });

    const projected = await dataSource.getRepository(ItemTopicEntity).find();
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({
      extractionId,
      inboxItemId,
      userId: USER,
      topicId: hausbau,
      name: 'Hausbau',
      confidence: 0.9,
    });
  });

  it('never persists hallucinated or foreign topic ids', async () => {
    const mine = await createTopic('Hausbau');
    const theirs = await createTopic('Theirs', OTHER_USER);
    const { inboxItemId, extractionId } = await seedJob();
    const provider = fakeProvider(() => ({
      assignments: [
        { topicId: mine, confidence: 0.8 },
        // Hallucinated id, never in any taxonomy.
        { topicId: 'ffffffff-ffff-ffff-ffff-ffffffffffff', confidence: 0.99 },
        // Another user's real topic id.
        { topicId: theirs, confidence: 0.95 },
      ],
      model: 'test-model',
    }));

    await buildProcessor(provider).process({ extractionId, inboxItemId });

    const payload = topicClassificationPayloadSchema.parse(
      JSON.parse((await extractionRow(extractionId)).content!),
    );
    expect(payload.assignments.map((a) => a.topicId)).toEqual([mine]);
    const projected = await dataSource.getRepository(ItemTopicEntity).find();
    expect(projected.map((r) => r.topicId)).toEqual([mine]);
  });

  it('only offers the owner\'s active topics as candidates', async () => {
    await createTopic('Active');
    await createTopic('Archived', USER, true);
    await createTopic('Foreign', OTHER_USER);
    const { inboxItemId, extractionId } = await seedJob();
    const provider = fakeProvider(() => ({ assignments: [] }));

    await buildProcessor(provider).process({ extractionId, inboxItemId });

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].topics.map((t) => t.name)).toEqual(['Active']);
  });

  it('refreshes the latest-only projection on reprocess', async () => {
    const hausbau = await createTopic('Hausbau');
    const work = await createTopic('Work');
    const { inboxItemId, extractionId } = await seedJob();
    const first = fakeProvider(() => ({
      assignments: [{ topicId: hausbau, confidence: 0.9 }],
    }));
    await buildProcessor(first).process({ extractionId, inboxItemId });

    // A fresh (append-only) topics row for the same item classifies differently.
    const secondExtractionId = await createExtraction(
      inboxItemId,
      'topics',
      'queued',
      new Date('2026-07-01T11:00:00Z'),
    );
    const second = fakeProvider(() => ({
      assignments: [{ topicId: work, confidence: 0.6 }],
    }));
    await buildProcessor(second).process({ extractionId: secondExtractionId, inboxItemId });

    // The old extraction's payload is untouched (immutable history)...
    const firstPayload = topicClassificationPayloadSchema.parse(
      JSON.parse((await extractionRow(extractionId)).content!),
    );
    expect(firstPayload.assignments.map((a) => a.topicId)).toEqual([hausbau]);
    // ...but the projection only carries the latest run's assignments.
    const projected = await dataSource.getRepository(ItemTopicEntity).find();
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ extractionId: secondExtractionId, topicId: work });
  });

  it('succeeds with no assignments and no LLM call when the taxonomy is empty', async () => {
    const { inboxItemId, extractionId } = await seedJob();
    const provider = fakeProvider(() => {
      throw new Error('must not be called');
    });

    await buildProcessor(provider).process({ extractionId, inboxItemId });

    expect(provider.calls).toHaveLength(0);
    const row = await extractionRow(extractionId);
    expect(row.status).toBe('succeeded');
    expect(topicClassificationPayloadSchema.parse(JSON.parse(row.content!))).toEqual({
      model: null,
      assignments: [],
    });
    expect(await dataSource.getRepository(ItemTopicEntity).count()).toBe(0);
  });

  it('fails the extraction when there is nothing to classify', async () => {
    const inboxItemId = await createItem();
    const extractionId = await createExtraction(inboxItemId, 'topics', 'queued', new Date());
    const provider = fakeProvider(() => ({ assignments: [] }));

    await expect(
      buildProcessor(provider).process({ extractionId, inboxItemId }),
    ).rejects.toThrow(/nothing to classify/);
    expect((await extractionRow(extractionId)).status).toBe('failed');
  });

  it('marks the extraction failed when the provider throws', async () => {
    await createTopic('Hausbau');
    const { inboxItemId, extractionId } = await seedJob();
    const provider = fakeProvider(() => {
      throw new Error('provider exploded');
    });

    await expect(
      buildProcessor(provider).process({ extractionId, inboxItemId }),
    ).rejects.toThrow('provider exploded');
    const row = await extractionRow(extractionId);
    expect(row.status).toBe('failed');
    expect(row.error).toBe('provider exploded');
    expect(await dataSource.getRepository(ItemTopicEntity).count()).toBe(0);
  });
});

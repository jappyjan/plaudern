import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicDocumentEntity,
  TopicEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import { TopicDocumentProcessor } from './topic-document.processor';
import type {
  TopicDocumentInput,
  TopicDocumentProvider,
  TopicDocumentResult,
} from './topic-document.provider';

const USER = '00000000-0000-0000-0000-0000000000aa';

/** Minimal InboxService stand-in — the processor only calls getItemById. */
function fakeInbox(dataSource: DataSource): InboxService {
  const items = dataSource.getRepository(InboxItemEntity);
  return {
    async getItemById(id: string) {
      return items.findOne({ where: { id }, relations: { source: true, extractions: true } });
    },
  } as unknown as InboxService;
}

/** Programmable provider fake that records every generate() call. */
function fakeProvider(
  respond: (input: TopicDocumentInput) => TopicDocumentResult,
): TopicDocumentProvider & { calls: TopicDocumentInput[] } {
  const calls: TopicDocumentInput[] = [];
  return {
    id: 'test:docs',
    enabled: true,
    calls,
    generate: async (input) => {
      calls.push(input);
      return respond(input);
    },
  };
}

describe('TopicDocumentProcessor', () => {
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

  function build(provider: TopicDocumentProvider): TopicDocumentProcessor {
    return new TopicDocumentProcessor(
      provider,
      fakeInbox(dataSource),
      dataSource.getRepository(TopicDocumentEntity),
      dataSource.getRepository(TopicEntity),
      dataSource.getRepository(ItemTopicEntity),
    );
  }

  async function createTopic(name = 'Hausbau'): Promise<string> {
    const row = await dataSource
      .getRepository(TopicEntity)
      .save({ userId: USER, name, description: 'The house build', archived: false });
    return row.id;
  }

  /** Seed an item classified into the topic, carrying a transcription. */
  async function classifyItem(topicId: string, text: string, occurredAt: string): Promise<string> {
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt,
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const extraction = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'transcription',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      content: text,
    });
    await dataSource.getRepository(ItemTopicEntity).save({
      extractionId: extraction.id,
      inboxItemId: item.id,
      userId: USER,
      topicId,
      name: 'Hausbau',
      confidence: 0.9,
    });
    return item.id;
  }

  async function queuedDoc(topicId: string, version = 1): Promise<string> {
    const row = await dataSource
      .getRepository(TopicDocumentEntity)
      .save({ userId: USER, topicId, version, status: 'queued' });
    return row.id;
  }

  it('generates a version, sorts sources by occurrence, and cites used markers', async () => {
    const topicId = await createTopic();
    const oldItem = await classifyItem(topicId, 'We poured the foundation.', '2026-06-01T10:00:00Z');
    const newItem = await classifyItem(topicId, 'We finished the roof.', '2026-06-10T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    // Cite only source [1] so we can assert citations track actual usage.
    const provider = fakeProvider(() => ({
      markdown: '## Timeline\n- Foundation poured [1]\n- Roof done',
      model: 'test-model',
    }));

    await build(provider).process({ documentId, topicId, userId: USER });

    // Sources are oldest-first: [1] = foundation (old), [2] = roof (new).
    expect(provider.calls).toHaveLength(1);
    const input = provider.calls[0];
    expect(input.topicName).toBe('Hausbau');
    expect(input.sources.map((s) => s.inboxItemId)).toEqual([oldItem, newItem]);
    expect(input.sources.map((s) => s.marker)).toEqual([1, 2]);
    expect(input.previousMarkdown).toBeNull();

    const row = await dataSource.getRepository(TopicDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('succeeded');
    expect(row.sourceItemCount).toBe(2);
    expect(row.model).toBe('test-model');
    // Only marker [1] was used, so only that source is cited.
    expect(row.citations).toHaveLength(1);
    expect(row.citations![0]).toMatchObject({ marker: 1, inboxItemId: oldItem, startSeconds: null });
  });

  it('strips out-of-range markers so hallucinated citations never render', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'Only one source.', '2026-06-01T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    const provider = fakeProvider(() => ({ markdown: 'A claim [1] and a bogus one [7].' }));
    await build(provider).process({ documentId, topicId, userId: USER });

    const row = await dataSource.getRepository(TopicDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.markdown).toBe('A claim [1] and a bogus one .');
    expect(row.citations).toHaveLength(1);
  });

  it('passes the previous document body so generation updates rather than rewrites', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'Update.', '2026-06-01T10:00:00Z');
    await dataSource.getRepository(TopicDocumentEntity).save({
      userId: USER,
      topicId,
      version: 1,
      status: 'succeeded',
      markdown: '## Overview\nEarlier state.',
    });
    const documentId = await queuedDoc(topicId, 2);

    const provider = fakeProvider(() => ({ markdown: '## Overview\nNewer.' }));
    await build(provider).process({ documentId, topicId, userId: USER });

    expect(provider.calls[0].previousMarkdown).toBe('## Overview\nEarlier state.');
  });

  it('marks the version failed when the provider throws', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'Something.', '2026-06-01T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    const provider = fakeProvider(() => {
      throw new Error('llm exploded');
    });
    await expect(build(provider).process({ documentId, topicId, userId: USER })).rejects.toThrow(
      'llm exploded',
    );

    const row = await dataSource.getRepository(TopicDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('failed');
    expect(row.error).toBe('llm exploded');
  });

  it('prunes old succeeded history after a successful generation (JJ-73)', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'Something worth documenting.', '2026-06-01T10:00:00Z');
    const documents = dataSource.getRepository(TopicDocumentEntity);

    // 10 pre-existing succeeded versions (the retention window) plus the fresh
    // one this run produces — the run must prune down to the 10 most recent
    // succeeded versions, i.e. drop version 1.
    for (let version = 1; version <= 10; version += 1) {
      await documents.save(
        documents.create({ userId: USER, topicId, version, status: 'succeeded', markdown: `## v${version}` }),
      );
    }
    const documentId = await queuedDoc(topicId, 11);

    const provider = fakeProvider(() => ({ markdown: '## v11', model: 'test-model' }));
    await build(provider).process({ documentId, topicId, userId: USER });

    const remaining = await documents.find({ where: { topicId }, order: { version: 'ASC' } });
    expect(remaining.map((r) => r.version)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // The current version must always survive.
    expect(remaining.find((r) => r.version === 11)?.status).toBe('succeeded');
  });

  it('fails cleanly when no classified item has usable content', async () => {
    const topicId = await createTopic();
    // An assignment with no transcription/summary content behind it.
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId: USER,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-06-01T10:00:00Z',
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
      userId: USER,
      topicId,
      name: 'Hausbau',
      confidence: 0.9,
    });
    const documentId = await queuedDoc(topicId);

    const provider = fakeProvider(() => ({ markdown: 'unused' }));
    await expect(build(provider).process({ documentId, topicId, userId: USER })).rejects.toThrow(
      /no classified items with usable content/,
    );
    expect(provider.calls).toHaveLength(0);
  });
});

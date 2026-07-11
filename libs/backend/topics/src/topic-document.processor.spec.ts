import type { ModuleRef } from '@nestjs/core';
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
import type { TopicDocumentService } from './topic-document.service';
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

/**
 * Programmable provider fake that records every generate() call. `respond` may
 * be async so a test can mutate the DB mid-generation (e.g. classify a new item
 * while the "LLM call" runs) to exercise the JJ-76 completion re-check.
 */
function fakeProvider(
  respond: (input: TopicDocumentInput) => TopicDocumentResult | Promise<TopicDocumentResult>,
): TopicDocumentProvider & { calls: TopicDocumentInput[] } {
  const calls: TopicDocumentInput[] = [];
  return {
    id: 'test:docs',
    calls,
    generate: async (_userId: string, input: TopicDocumentInput) => {
      calls.push(input);
      return respond(input);
    },
  };
}

describe('TopicDocumentProcessor', () => {
  let dataSource: DataSource;
  /** Every (userId, topicId) the processor asked the service to re-enqueue. */
  let reenqueued: { userId: string; topicId: string }[];

  beforeEach(async () => {
    dataSource = new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: ALL_ENTITIES,
      synchronize: true,
    });
    await dataSource.initialize();
    reenqueued = [];
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  function build(provider: TopicDocumentProvider): TopicDocumentProcessor {
    // The processor resolves TopicDocumentService lazily via ModuleRef only to
    // re-enqueue a follow-up; a fake that records the calls is all we need.
    const service = {
      enqueueRegeneration: async (userId: string, topicId: string) => {
        reenqueued.push({ userId, topicId });
        return 'reenqueued-id';
      },
    } as unknown as TopicDocumentService;
    const moduleRef = { get: () => service } as unknown as ModuleRef;
    return new TopicDocumentProcessor(
      provider,
      fakeInbox(dataSource),
      dataSource.getRepository(TopicDocumentEntity),
      dataSource.getRepository(TopicEntity),
      dataSource.getRepository(ItemTopicEntity),
      moduleRef,
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

  it('re-enqueues a follow-up when an item is classified DURING generation (JJ-76)', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'First item, present before the run.', '2026-06-01T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    // The "LLM call" classifies a second item into the topic mid-generation —
    // it lands AFTER the processor read its sources, so this version can't cover
    // it. The completion re-check must notice and re-enqueue exactly one
    // follow-up generation (which, run later, would read both items).
    let injected = false;
    const provider = fakeProvider(async () => {
      if (!injected) {
        injected = true;
        await classifyItem(topicId, 'Second item, arrived mid-run.', '2026-06-02T10:00:00Z');
      }
      return { markdown: '## doc [1]', model: 'test-model' };
    });
    await build(provider).process({ documentId, topicId, userId: USER });

    // The version still succeeded (covering only the item it read)…
    const row = await dataSource.getRepository(TopicDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('succeeded');
    expect(row.sourceItemCount).toBe(1);
    // …and the newly-arrived item is not dropped: a single follow-up was enqueued.
    expect(reenqueued).toEqual([{ userId: USER, topicId }]);
  });

  it('does NOT re-enqueue when no new item arrived during generation (JJ-76)', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'The only item.', '2026-06-01T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    const provider = fakeProvider(() => ({ markdown: '## doc [1]', model: 'test-model' }));
    await build(provider).process({ documentId, topicId, userId: USER });

    expect(reenqueued).toHaveLength(0);
  });

  it('re-arms the deferred re-check when generation THROWS mid-run (JJ-77)', async () => {
    const topicId = await createTopic();
    await classifyItem(topicId, 'First item, present before the run.', '2026-06-01T10:00:00Z');
    const documentId = await queuedDoc(topicId);

    // Same mid-run classification race as the JJ-76 success-path test, but
    // this time the "LLM call" itself throws after the new item lands. Before
    // JJ-77 the re-check only ran on the success branch, so a throw here would
    // silently drop the newly-classified item until unrelated future activity.
    let injected = false;
    const provider = fakeProvider(async () => {
      if (!injected) {
        injected = true;
        await classifyItem(topicId, 'Second item, arrived mid-run.', '2026-06-02T10:00:00Z');
      }
      throw new Error('llm exploded mid-run');
    });
    await expect(build(provider).process({ documentId, topicId, userId: USER })).rejects.toThrow(
      'llm exploded mid-run',
    );

    // The version is marked failed (existing failure-path behavior)…
    const row = await dataSource.getRepository(TopicDocumentEntity).findOneByOrFail({ id: documentId });
    expect(row.status).toBe('failed');
    // …but the deferred re-check still re-armed: the mid-run item is not lost.
    expect(reenqueued).toEqual([{ userId: USER, topicId }]);
  });

  it('does NOT re-arm the re-check when the failure happens before sources are snapshotted (JJ-77)', async () => {
    const topicId = await createTopic();
    // No classified items at all — the processor throws before `coveredItemIds`
    // is ever set, so there is nothing meaningful to compare against.
    const documentId = await queuedDoc(topicId);

    const provider = fakeProvider(() => ({ markdown: 'unused' }));
    await expect(build(provider).process({ documentId, topicId, userId: USER })).rejects.toThrow(
      /topic has no classified items to document/,
    );

    expect(reenqueued).toHaveLength(0);
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

import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicEntity,
  TopicProposalEntity,
  TopicProposalRunEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import type { EmbeddingSearchService } from '@plaudern/embeddings';
import type { AiConfigService } from '@plaudern/ai-config';
import type { TopicsService } from './topics.service';
import type { TopicProposalLabelProvider } from './topic-proposals.provider';
import { clusterFingerprint } from './topic-proposals.clustering';
import { TopicProposalsService } from './topic-proposals.service';
import { TopicProposalGenerationProcessor } from './topic-proposals.processor';
import type {
  TopicProposalGenerationJob,
  TopicProposalGenerationQueue,
} from './topic-proposals.job';

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER_USER = '00000000-0000-0000-0000-0000000000bb';

function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const base: Record<string, unknown> = {
    // Big window + low min-size so seeds cluster deterministically in tests.
    TOPIC_PROPOSALS_RECENT_DAYS: 36500,
    TOPIC_PROPOSALS_MIN_CLUSTER_SIZE: 3,
    TOPIC_PROPOSALS_SIMILARITY: 0.8,
  };
  const map = { ...base, ...overrides };
  return {
    get: (key: string, def?: unknown) => (key in map ? map[key] : def),
  } as unknown as ConfigService;
}

describe('TopicProposalsService (JJ-64/JJ-69)', () => {
  let dataSource: DataSource;
  let vectorMap: Map<string, number[]>;
  let enqueued: string[];
  let labelCalls: number;

  function fakeInbox(): InboxService {
    const items = dataSource.getRepository(InboxItemEntity);
    return {
      async getItemById(id: string) {
        return items.findOne({ where: { id }, relations: { extractions: true } });
      },
    } as unknown as InboxService;
  }

  function fakeTopics(enabled = true): TopicsService {
    return {
      async isEnabled(): Promise<boolean> {
        return enabled;
      },
      async enqueueTopics(inboxItemId: string): Promise<string> {
        enqueued.push(inboxItemId);
        return `ext-${inboxItemId}`;
      },
    } as unknown as TopicsService;
  }

  function fakeEmbeddings(opts: { enabled?: boolean; throwOnCentroids?: boolean } = {}): EmbeddingSearchService {
    return {
      async isEnabled(): Promise<boolean> {
        return opts.enabled ?? true;
      },
      async itemCentroids(_userId: string, ids: string[]) {
        if (opts.throwOnCentroids) throw new Error('embeddings exploded');
        return ids
          .filter((id) => vectorMap.has(id))
          .map((id) => ({ inboxItemId: id, vector: vectorMap.get(id)! }));
      },
    } as unknown as EmbeddingSearchService;
  }

  /** AiConfigService fake whose `topics` capability (shared by labeling) is on/off. */
  function fakeAiConfig(enabled = true): AiConfigService {
    return {
      resolve: async () => (enabled ? ({} as never) : null),
      isEnabled: async () => enabled,
      invalidate: () => {},
    } as unknown as AiConfigService;
  }

  function fakeLabeler(opts: { throws?: boolean } = {}): TopicProposalLabelProvider {
    return {
      id: 'test:labeler',
      async label() {
        labelCalls += 1;
        if (opts.throws) throw new Error('labeler down');
        return { label: 'Hausbau', description: 'Building a house', model: 'test' };
      },
    };
  }

  function buildProcessor(opts: {
    embeddingsEnabled?: boolean;
    throwOnCentroids?: boolean;
    labelerThrows?: boolean;
    config?: Record<string, unknown>;
  } = {}): TopicProposalGenerationProcessor {
    return new TopicProposalGenerationProcessor(
      makeConfig(opts.config),
      fakeInbox(),
      fakeEmbeddings({ enabled: opts.embeddingsEnabled ?? true, throwOnCentroids: opts.throwOnCentroids }),
      fakeLabeler({ throws: opts.labelerThrows }),
      dataSource.getRepository(TopicProposalEntity),
      dataSource.getRepository(TopicProposalRunEntity),
      dataSource.getRepository(InboxItemEntity),
    );
  }

  /** Queue that runs the processor synchronously, like InlineJobQueue in prod/dev. */
  function inlineQueue(processor: TopicProposalGenerationProcessor): TopicProposalGenerationQueue {
    return {
      async enqueue(job: TopicProposalGenerationJob) {
        try {
          await processor.process(job);
        } catch {
          /* failure already persisted on the run row */
        }
      },
    };
  }

  /** Queue that only records jobs, so a run stays `queued` until we run it — the
   *  async/BullMQ behavior the double-click guard is really about. */
  function deferredQueue(): TopicProposalGenerationQueue & { jobs: TopicProposalGenerationJob[] } {
    const jobs: TopicProposalGenerationJob[] = [];
    return {
      jobs,
      async enqueue(job: TopicProposalGenerationJob) {
        jobs.push(job);
      },
    };
  }

  function buildService(
    opts: { embeddingsEnabled?: boolean; topicsEnabled?: boolean } = {},
    queue?: TopicProposalGenerationQueue,
  ): TopicProposalsService {
    return new TopicProposalsService(
      fakeInbox(),
      fakeTopics(opts.topicsEnabled ?? true),
      fakeEmbeddings({ enabled: opts.embeddingsEnabled ?? true }),
      fakeAiConfig(opts.topicsEnabled ?? true),
      queue ?? inlineQueue(buildProcessor(opts)),
      dataSource.getRepository(TopicProposalEntity),
      dataSource.getRepository(TopicProposalRunEntity),
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
    vectorMap = new Map();
    enqueued = [];
    labelCalls = 0;
  });

  afterEach(async () => {
    await dataSource.destroy();
  });

  /** Seed a committed item + a succeeded transcription, register its vector. */
  async function seedItem(
    vector: number[],
    opts: { userId?: string; covered?: boolean } = {},
  ): Promise<string> {
    const userId = opts.userId ?? USER;
    const item = await dataSource.getRepository(InboxItemEntity).save({
      userId,
      deviceId: null,
      sourceType: 'plaud',
      occurredAt: '2026-07-01T10:00:00Z',
      idempotencyKey: `key-${Math.random()}`,
      metadata: null,
    });
    const ext = await dataSource.getRepository(ExtractedPayloadEntity).save({
      inboxItemId: item.id,
      kind: 'transcription',
      version: 1,
      provider: 'test',
      status: 'succeeded',
      content: 'notes about building the house',
    });
    if (opts.covered) {
      await dataSource.getRepository(ItemTopicEntity).save({
        extractionId: ext.id,
        inboxItemId: item.id,
        userId,
        topicId: '00000000-0000-0000-0000-0000000000ee',
        name: 'Existing',
        confidence: 0.9,
      });
    }
    vectorMap.set(item.id, vector);
    return item.id;
  }

  async function seedCluster(vector: number[], count: number, userId = USER): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) ids.push(await seedItem(vector, { userId }));
    return ids;
  }

  // ---- Generation (moved to the worker, driven inline here) ----

  it('creates one pending proposal per cluster and excludes covered items', async () => {
    const aIds = await seedCluster([1, 0], 4);
    await seedItem([1, 0], { covered: true }); // in cluster A's region but already covered
    const bIds = await seedCluster([0, 1], 3);

    const service = buildService();
    const res = await service.generate(USER);

    expect(res.enabled).toBe(true);
    expect(res.proposals).toHaveLength(2);
    const counts = res.proposals.map((p) => p.itemCount).sort((a, b) => b - a);
    expect(counts).toEqual([4, 3]); // covered item was not clustered into A
    const aProposal = res.proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)));
    const bProposal = res.proposals.find((p) => p.sampleItemIds.some((id) => bIds.includes(id)));
    expect(aProposal?.itemCount).toBe(4);
    expect(bProposal?.itemCount).toBe(3);
    expect(aProposal?.status).toBe('pending');
    // The run settled as succeeded (inline worker ran to completion).
    expect(res.generation.status).toBe('succeeded');
  });

  it('does not re-propose a dismissed cluster and does not duplicate a pending one', async () => {
    const aIds = await seedCluster([1, 0], 4);
    await seedCluster([0, 1], 3);

    const service = buildService();
    await service.generate(USER);
    let list = await service.listProposals(USER);
    expect(list.proposals).toHaveLength(2);

    const aProposal = list.proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;
    await service.dismiss(USER, aProposal.id);

    const res = await service.generate(USER);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0].sampleItemIds.some((id) => aIds.includes(id))).toBe(false);

    const allRows = await dataSource.getRepository(TopicProposalEntity).find();
    expect(allRows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(allRows.filter((r) => r.status === 'dismissed')).toHaveLength(1);
  });

  it('stores the cluster centroid on each created proposal (JJ-69)', async () => {
    await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const row = await dataSource.getRepository(TopicProposalEntity).findOneByOrFail({ userId: USER });
    expect(row.centroid).not.toBeNull();
    // Unit vector in the [1,0] direction.
    expect(row.centroid![0]).toBeCloseTo(1, 5);
    expect(row.centroid![1]).toBeCloseTo(0, 5);
  });

  it('accept creates the topic, reclassifies members, and marks the proposal accepted', async () => {
    const aIds = await seedCluster([1, 0], 4);
    await seedCluster([0, 1], 3);
    const service = buildService();
    await service.generate(USER);
    const list = await service.listProposals(USER);
    const aProposal = list.proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;

    const topic = await service.accept(USER, aProposal.id);

    expect(topic.name).toBe('Hausbau');
    expect(topic.description).toBe('Building a house');
    const topicRows = await dataSource.getRepository(TopicEntity).find();
    expect(topicRows).toHaveLength(1);
    expect(topicRows[0]).toMatchObject({ id: topic.id, userId: USER, name: 'Hausbau' });
    expect(new Set(enqueued)).toEqual(new Set(aIds));

    const row = await dataSource
      .getRepository(TopicProposalEntity)
      .findOneByOrFail({ id: aProposal.id });
    expect(row.status).toBe('accepted');
    expect(row.acceptedTopicId).toBe(topic.id);
    expect((await service.listProposals(USER)).proposals.some((p) => p.id === aProposal.id)).toBe(
      false,
    );
  });

  it('nulls acceptedTopicId when the accepted topic is deleted (FK ON DELETE SET NULL, JJ-69)', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const list = await service.listProposals(USER);
    const aProposal = list.proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;
    const topic = await service.accept(USER, aProposal.id);

    // Delete the topic directly (better-sqlite3 enforces foreign_keys by default).
    await dataSource.getRepository(TopicEntity).delete({ id: topic.id });

    const row = await dataSource
      .getRepository(TopicProposalEntity)
      .findOneByOrFail({ id: aProposal.id });
    // The row survives (not cascaded) but its dangling reference is cleared.
    expect(row.status).toBe('accepted');
    expect(row.acceptedTopicId).toBeNull();
  });

  it('accept loses cleanly when the proposal is resolved between check and claim (race guard)', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const { proposals } = await service.listProposals(USER);
    const proposal = proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;

    const repo = dataSource.getRepository(TopicProposalEntity);
    const stale = await repo.findOneByOrFail({ id: proposal.id });
    await repo.update({ id: proposal.id }, { status: 'dismissed' });
    const spy = jest.spyOn(repo, 'findOne').mockResolvedValueOnce({ ...stale, status: 'pending' });
    try {
      await expect(service.accept(USER, proposal.id)).rejects.toBeInstanceOf(ConflictException);
    } finally {
      spy.mockRestore();
    }

    expect(await dataSource.getRepository(TopicEntity).count()).toBe(0);
    expect(enqueued).toHaveLength(0);
    const row = await repo.findOneByOrFail({ id: proposal.id });
    expect(row.status).toBe('dismissed');
    expect(row.acceptedTopicId).toBeNull();
  });

  it('generate skips a cluster whose fingerprint was concurrently stored (unique index)', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const bIds = await seedCluster([0, 1], 3);

    await dataSource.getRepository(TopicProposalEntity).save({
      userId: USER,
      fingerprint: clusterFingerprint(aIds),
      label: 'Concurrent winner',
      description: null,
      itemCount: aIds.length,
      memberItemIds: [],
      sampleItemIds: [],
      centroid: null,
      status: 'pending',
      acceptedTopicId: null,
    });

    const service = buildService();
    await service.generate(USER);

    const rows = await dataSource.getRepository(TopicProposalEntity).find({ where: { userId: USER } });
    const aRows = rows.filter((r) => r.fingerprint === clusterFingerprint(aIds));
    expect(aRows).toHaveLength(1);
    expect(aRows[0].label).toBe('Concurrent winner');
    expect(rows.some((r) => r.fingerprint === clusterFingerprint(bIds))).toBe(true);
  });

  // ---- Centroid-based suppression of regrown dismissed clusters (JJ-69) ----

  it('suppresses a regrown dismissed cluster by centroid even when Jaccard no longer matches', async () => {
    // A dismissed cluster whose MEMBER ids share nothing with a future cluster
    // (so member Jaccard = 0) but whose stored centroid points the same way.
    await dataSource.getRepository(TopicProposalEntity).save({
      userId: USER,
      fingerprint: 'dismissed-a',
      label: 'Old Hausbau',
      description: null,
      itemCount: 3,
      memberItemIds: ['ghost-1', 'ghost-2', 'ghost-3'],
      sampleItemIds: [],
      centroid: [1, 0], // same direction as the fresh [1,0] cluster below
      status: 'dismissed',
      acceptedTopicId: null,
    });
    await seedCluster([1, 0], 4); // fresh cluster, brand-new item ids

    const service = buildService();
    const res = await service.generate(USER);

    // Centroid cosine >= threshold suppresses it despite zero member overlap.
    expect(res.proposals).toHaveLength(0);
    expect(labelCalls).toBe(0);
  });

  it('falls back to Jaccard-only for legacy dismissed rows without a stored centroid', async () => {
    // Same shape, but centroid is null (a pre-JJ-69 row): the direction match is
    // invisible, member Jaccard is 0, so the fresh cluster is NOT suppressed.
    await dataSource.getRepository(TopicProposalEntity).save({
      userId: USER,
      fingerprint: 'legacy-a',
      label: 'Legacy',
      description: null,
      itemCount: 3,
      memberItemIds: ['ghost-1', 'ghost-2', 'ghost-3'],
      sampleItemIds: [],
      centroid: null,
      status: 'dismissed',
      acceptedTopicId: null,
    });
    await seedCluster([1, 0], 4);

    const service = buildService();
    const res = await service.generate(USER);

    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0].itemCount).toBe(4);
  });

  // ---- Retention bound (JJ-69) ----

  it('prunes resolved proposals down to the newest N per user after a run', async () => {
    const repo = dataSource.getRepository(TopicProposalEntity);
    // Five dismissed rows with distinct, ascending createdAt; non-overlapping,
    // centroid-less so none suppress the fresh [0,1] cluster.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await repo.save({
        userId: USER,
        fingerprint: `resolved-${i}`,
        label: `R${i}`,
        description: null,
        itemCount: 3,
        memberItemIds: [`r${i}-a`, `r${i}-b`, `r${i}-c`],
        sampleItemIds: [],
        centroid: null,
        status: 'dismissed',
        acceptedTopicId: null,
      });
      await repo.update({ id: row.id }, { createdAt: new Date(2020, 0, i + 1) });
      ids.push(row.id);
    }
    await seedCluster([0, 1], 4); // a fresh cluster so generate() runs the prune

    // retention = 2 (the processor owns the prune).
    const processor = buildProcessor({ config: { TOPIC_PROPOSALS_RETENTION: 2 } });
    const svc = new TopicProposalsService(
      fakeInbox(),
      fakeTopics(true),
      fakeEmbeddings({ enabled: true }),
      fakeAiConfig(true),
      inlineQueue(processor),
      dataSource.getRepository(TopicProposalEntity),
      dataSource.getRepository(TopicProposalRunEntity),
    );
    await svc.generate(USER);

    const remaining = await repo.find({ where: { userId: USER, status: 'dismissed' }, order: { createdAt: 'DESC' } });
    // Only the newest 2 resolved rows survive.
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.fingerprint)).toEqual(['resolved-4', 'resolved-3']);
    // Oldest rows were the ones pruned.
    const survivingIds = new Set(remaining.map((r) => r.id));
    expect(survivingIds.has(ids[0])).toBe(false);
    // A fresh proposal was still created.
    expect(await repo.count({ where: { userId: USER, status: 'pending' } })).toBe(1);
  });

  // ---- Async enqueue-and-return + double-click guard (JJ-69) ----

  it('enqueue-and-return: a run stays queued and the list reports it while the worker is pending', async () => {
    await seedCluster([1, 0], 4);
    const queue = deferredQueue();
    const service = buildService({}, queue);

    const res = await service.generate(USER);
    expect(queue.jobs).toHaveLength(1);
    expect(res.generation.status).toBe('queued');
    // Nothing labeled/persisted yet — the worker hasn't run.
    expect(res.proposals).toHaveLength(0);
    expect(labelCalls).toBe(0);

    // Now run the deferred job and the results appear.
    const processor = buildProcessor();
    await processor.process(queue.jobs[0]);
    const after = await service.listProposals(USER);
    expect(after.generation.status).toBe('succeeded');
    expect(after.proposals).toHaveLength(1);
  });

  it('coalesces a double-click onto one in-flight run instead of enqueuing a duplicate', async () => {
    await seedCluster([1, 0], 4);
    const queue = deferredQueue();
    const service = buildService({}, queue);

    const [first, second] = await Promise.all([service.generate(USER), service.generate(USER)]);
    expect(queue.jobs).toHaveLength(1); // exactly one run enqueued
    expect(first.generation.status).toBe('queued');
    expect(second.generation.status).toBe('queued');
    // A single run row exists for the user.
    expect(await dataSource.getRepository(TopicProposalRunEntity).count()).toBe(1);
  });

  it('a fresh generate after a run finishes starts a new run (terminal -> queued flip)', async () => {
    await seedCluster([1, 0], 4);
    const queue = deferredQueue();
    const service = buildService({}, queue);
    const processor = buildProcessor();

    await service.generate(USER); // enqueues run 1
    await processor.process(queue.jobs[0]); // run 1 -> succeeded
    expect((await service.listProposals(USER)).generation.status).toBe('succeeded');

    await service.generate(USER); // terminal -> queued again
    expect(queue.jobs).toHaveLength(2);
    expect((await service.listProposals(USER)).generation.status).toBe('queued');
  });

  // ---- Run failure surfacing (JJ-69) ----

  it('marks the run failed and surfaces the error when generation throws', async () => {
    await seedCluster([1, 0], 4);
    const processor = buildProcessor({ throwOnCentroids: true });
    const service = new TopicProposalsService(
      fakeInbox(),
      fakeTopics(true),
      fakeEmbeddings({ enabled: true }),
      fakeAiConfig(true),
      inlineQueue(processor),
      dataSource.getRepository(TopicProposalEntity),
      dataSource.getRepository(TopicProposalRunEntity),
    );

    const res = await service.generate(USER);
    expect(res.generation.status).toBe('failed');
    expect(res.generation.error).toContain('embeddings exploded');
    expect(res.proposals).toHaveLength(0);
  });

  // ---- Enabled gating ----

  it('rejects accepting/dismissing an unknown or already-resolved proposal', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const { proposals } = await service.listProposals(USER);
    const proposal = proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;

    await expect(service.accept(USER, proposal.id)).resolves.toBeDefined();
    await expect(service.accept(USER, proposal.id)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.dismiss(OTHER_USER, proposal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.accept(USER, '00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports disabled and no-ops generate (no enqueue) when embeddings are absent', async () => {
    await seedCluster([1, 0], 4);
    const queue = deferredQueue();
    const service = buildService({ embeddingsEnabled: false }, queue);

    const res = await service.generate(USER);
    expect(res.enabled).toBe(false);
    expect(res.proposals).toHaveLength(0);
    expect(queue.jobs).toHaveLength(0);
    expect(res.generation.status).toBeNull();
  });

  it('reports disabled when the topics capability (labeling LLM) is absent', async () => {
    const service = buildService({ topicsEnabled: false });
    const res = await service.listProposals(USER);
    expect(res.enabled).toBe(false);
  });
});

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
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import type { EmbeddingSearchService } from '@plaudern/embeddings';
import type { AiConfigService } from '@plaudern/ai-config';
import type { TopicsService } from './topics.service';
import type { TopicProposalLabelProvider } from './topic-proposals.provider';
import { clusterFingerprint } from './topic-proposals.clustering';
import { TopicProposalsService } from './topic-proposals.service';

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

describe('TopicProposalsService', () => {
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

  // The topic row itself is created inside accept()'s transaction (via the
  // entity manager), so the fake only supplies the enabled gate and the
  // reclassification enqueue.
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

  function fakeEmbeddings(enabled = true): EmbeddingSearchService {
    return {
      async isEnabled(): Promise<boolean> {
        return enabled;
      },
      async itemCentroids(_userId: string, ids: string[]) {
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

  function fakeLabeler(): TopicProposalLabelProvider {
    return {
      id: 'test:labeler',
      async label() {
        labelCalls += 1;
        return { label: 'Hausbau', description: 'Building a house', model: 'test' };
      },
    };
  }

  function buildService(opts: {
    embeddingsEnabled?: boolean;
    topicsEnabled?: boolean;
    config?: Record<string, unknown>;
  } = {}): TopicProposalsService {
    return new TopicProposalsService(
      makeConfig(opts.config),
      fakeInbox(),
      fakeTopics(opts.topicsEnabled ?? true),
      fakeEmbeddings(opts.embeddingsEnabled ?? true),
      fakeAiConfig(opts.topicsEnabled ?? true),
      fakeLabeler(),
      dataSource.getRepository(TopicProposalEntity),
      dataSource.getRepository(InboxItemEntity),
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
    // Every proposal member is a seeded, uncovered item of the right cluster.
    const aProposal = res.proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)));
    const bProposal = res.proposals.find((p) => p.sampleItemIds.some((id) => bIds.includes(id)));
    expect(aProposal?.itemCount).toBe(4);
    expect(bProposal?.itemCount).toBe(3);
    expect(aProposal?.status).toBe('pending');
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

    // Regenerate: A is suppressed (dismissed), B is unchanged (already pending).
    const res = await service.generate(USER);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0].sampleItemIds.some((id) => aIds.includes(id))).toBe(false);

    // No duplicate rows were created for the still-pending B cluster.
    const allRows = await dataSource.getRepository(TopicProposalEntity).find();
    expect(allRows.filter((r) => r.status === 'pending')).toHaveLength(1);
    expect(allRows.filter((r) => r.status === 'dismissed')).toHaveLength(1);
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
    // The topic landed in the taxonomy table (created inside the transaction).
    const topicRows = await dataSource.getRepository(TopicEntity).find();
    expect(topicRows).toHaveLength(1);
    expect(topicRows[0]).toMatchObject({
      id: topic.id,
      userId: USER,
      name: 'Hausbau',
      description: 'Building a house',
      archived: false,
    });
    // All four cluster members were re-enqueued for classification.
    expect(new Set(enqueued)).toEqual(new Set(aIds));

    const row = await dataSource
      .getRepository(TopicProposalEntity)
      .findOneByOrFail({ id: aProposal.id });
    expect(row.status).toBe('accepted');
    expect(row.acceptedTopicId).toBe(topic.id);
    // Accepted proposals drop out of the pending list.
    expect((await service.listProposals(USER)).proposals.some((p) => p.id === aProposal.id)).toBe(
      false,
    );
  });

  it('accept loses cleanly when the proposal is resolved between check and claim (race guard)', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const { proposals } = await service.listProposals(USER);
    const proposal = proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;

    // Simulate the multi-tab race: the row is resolved AFTER this request's
    // pending pre-check but BEFORE its claim. The stale pre-check read passes;
    // the guarded conditional update must then affect zero rows and Conflict.
    const repo = dataSource.getRepository(TopicProposalEntity);
    const stale = await repo.findOneByOrFail({ id: proposal.id });
    await repo.update({ id: proposal.id }, { status: 'dismissed' });
    const spy = jest.spyOn(repo, 'findOne').mockResolvedValueOnce({ ...stale, status: 'pending' });
    try {
      await expect(service.accept(USER, proposal.id)).rejects.toBeInstanceOf(ConflictException);
    } finally {
      spy.mockRestore();
    }

    // The losing accept created no topic and enqueued no reclassification.
    expect(await dataSource.getRepository(TopicEntity).count()).toBe(0);
    expect(enqueued).toHaveLength(0);
    const row = await repo.findOneByOrFail({ id: proposal.id });
    expect(row.status).toBe('dismissed');
    expect(row.acceptedTopicId).toBeNull();
  });

  it('generate skips a cluster whose fingerprint was concurrently stored (unique index)', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const bIds = await seedCluster([0, 1], 3);

    // Simulate a concurrent generate having already stored cluster A: same
    // (userId, fingerprint), but member ids that defeat the Jaccard pre-check —
    // forcing this run's insert to hit the unique index instead.
    await dataSource.getRepository(TopicProposalEntity).save({
      userId: USER,
      fingerprint: clusterFingerprint(aIds),
      label: 'Concurrent winner',
      description: null,
      itemCount: aIds.length,
      memberItemIds: [],
      sampleItemIds: [],
      status: 'pending',
      acceptedTopicId: null,
    });

    const service = buildService();
    // Must not throw: the violation is caught and the cluster skipped.
    await service.generate(USER);

    const rows = await dataSource.getRepository(TopicProposalEntity).find({
      where: { userId: USER },
    });
    // Exactly one row for cluster A (the concurrent winner, label untouched)...
    const aRows = rows.filter((r) => r.fingerprint === clusterFingerprint(aIds));
    expect(aRows).toHaveLength(1);
    expect(aRows[0].label).toBe('Concurrent winner');
    // ...and the run continued: cluster B was still proposed.
    expect(rows.some((r) => r.fingerprint === clusterFingerprint(bIds))).toBe(true);
  });

  it('coalesces a generate call while one is already in flight for the user', async () => {
    await seedCluster([1, 0], 4);
    const service = buildService();

    // Fire two overlapping generates; the in-process guard lets only one run.
    const [first, second] = await Promise.all([service.generate(USER), service.generate(USER)]);
    expect(first.enabled).toBe(true);
    expect(second.enabled).toBe(true);

    const rows = await dataSource.getRepository(TopicProposalEntity).find();
    expect(rows).toHaveLength(1);
    expect(labelCalls).toBe(1);
  });

  it('rejects accepting/dismissing an unknown or already-resolved proposal', async () => {
    const aIds = await seedCluster([1, 0], 4);
    const service = buildService();
    await service.generate(USER);
    const { proposals } = await service.listProposals(USER);
    const proposal = proposals.find((p) => p.sampleItemIds.some((id) => aIds.includes(id)))!;

    await expect(service.accept(USER, proposal.id)).resolves.toBeDefined();
    // Second accept: already resolved.
    await expect(service.accept(USER, proposal.id)).rejects.toBeInstanceOf(ConflictException);
    // Foreign user cannot see it.
    await expect(service.dismiss(OTHER_USER, proposal.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.accept(USER, '00000000-0000-0000-0000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports disabled and no-ops generate when embeddings are absent', async () => {
    await seedCluster([1, 0], 4);
    const service = buildService({ embeddingsEnabled: false });

    const res = await service.generate(USER);
    expect(res.enabled).toBe(false);
    expect(res.proposals).toHaveLength(0);
    expect(labelCalls).toBe(0);
  });

  it('reports disabled when the topics capability (labeling LLM) is absent', async () => {
    const service = buildService({ topicsEnabled: false });
    const res = await service.listProposals(USER);
    expect(res.enabled).toBe(false);
  });
});

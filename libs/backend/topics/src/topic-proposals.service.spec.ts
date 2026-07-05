import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import {
  ALL_ENTITIES,
  ExtractedPayloadEntity,
  InboxItemEntity,
  ItemTopicEntity,
  TopicProposalEntity,
} from '@plaudern/persistence';
import type { InboxService } from '@plaudern/inbox';
import type { EmbeddingSearchService } from '@plaudern/embeddings';
import type { CreateTopicRequest, TopicDto } from '@plaudern/contracts';
import type { TopicsService } from './topics.service';
import type { TopicProposalLabelProvider } from './topic-proposals.provider';
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
  let createdTopics: Array<{ userId: string; req: CreateTopicRequest }>;
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
      get enabled() {
        return enabled;
      },
      async createTopic(userId: string, req: CreateTopicRequest): Promise<TopicDto> {
        createdTopics.push({ userId, req });
        const now = new Date().toISOString();
        return {
          id: '00000000-0000-0000-0000-0000000000cc',
          name: req.name,
          description: req.description ?? null,
          archived: false,
          createdAt: now,
          updatedAt: now,
        };
      },
      async enqueueTopics(inboxItemId: string): Promise<string> {
        enqueued.push(inboxItemId);
        return `ext-${inboxItemId}`;
      },
    } as unknown as TopicsService;
  }

  function fakeEmbeddings(enabled = true): EmbeddingSearchService {
    return {
      get enabled() {
        return enabled;
      },
      async itemCentroids(_userId: string, ids: string[]) {
        return ids
          .filter((id) => vectorMap.has(id))
          .map((id) => ({ inboxItemId: id, vector: vectorMap.get(id)! }));
      },
    } as unknown as EmbeddingSearchService;
  }

  function fakeLabeler(enabled = true): TopicProposalLabelProvider {
    return {
      id: 'test:labeler',
      enabled,
      async label() {
        labelCalls += 1;
        return { label: 'Hausbau', description: 'Building a house', model: 'test' };
      },
    };
  }

  function buildService(opts: {
    embeddingsEnabled?: boolean;
    labelerEnabled?: boolean;
    topicsEnabled?: boolean;
    config?: Record<string, unknown>;
  } = {}): TopicProposalsService {
    return new TopicProposalsService(
      makeConfig(opts.config),
      fakeInbox(),
      fakeTopics(opts.topicsEnabled ?? true),
      fakeEmbeddings(opts.embeddingsEnabled ?? true),
      fakeLabeler(opts.labelerEnabled ?? true),
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
    createdTopics = [];
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
    expect(createdTopics).toEqual([
      { userId: USER, req: { name: 'Hausbau', description: 'Building a house' } },
    ]);
    // All four cluster members were re-enqueued for classification.
    expect(new Set(enqueued)).toEqual(new Set(aIds));

    const row = await dataSource
      .getRepository(TopicProposalEntity)
      .findOneByOrFail({ id: aProposal.id });
    expect(row.status).toBe('accepted');
    expect(row.acceptedTopicId).toBe('00000000-0000-0000-0000-0000000000cc');
    // Accepted proposals drop out of the pending list.
    expect((await service.listProposals(USER)).proposals.some((p) => p.id === aProposal.id)).toBe(
      false,
    );
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

  it('reports disabled when the labeling LLM is absent', async () => {
    const service = buildService({ labelerEnabled: false });
    const res = await service.listProposals(USER);
    expect(res.enabled).toBe(false);
  });
});

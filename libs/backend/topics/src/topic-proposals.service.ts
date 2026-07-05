import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InboxService } from '@plaudern/inbox';
import { EmbeddingSearchService } from '@plaudern/embeddings';
import type { TopicDto, TopicProposalDto, TopicProposalListResponse } from '@plaudern/contracts';
import { InboxItemEntity, ItemTopicEntity, TopicProposalEntity } from '@plaudern/persistence';
import { TopicsService } from './topics.service';
import { buildTopicContent } from './topic-context';
import {
  clusterFingerprint,
  clusterItems,
  jaccard,
  type ClusterInput,
} from './topic-proposals.clustering';
import {
  TOPIC_PROPOSAL_LABEL_PROVIDER,
  type TopicProposalLabelProvider,
} from './topic-proposals.provider';

/** Number of member excerpts sent to the labeler and stored for the UI preview. */
const SAMPLE_ITEMS = 6;
/** Per-sample excerpt length — enough to name the theme, small enough to stay cheap. */
const SAMPLE_CHARS = 600;

/**
 * Proposes taxonomy extensions from embedding clusters (JJ-64). On demand
 * (a "suggest topics" trigger from the topics UI) it clusters the user's recent
 * item embeddings, excludes items already well-covered by the existing taxonomy,
 * labels each new cluster with the LLM, and stores pending proposals. Accepting
 * one creates the topic and reclassifies the cluster's items via the existing
 * per-item topics pipeline; dismissed/accepted rows are retained so their
 * clusters are not re-proposed.
 *
 * The whole feature degrades to disabled when either embeddings or the labeling
 * LLM are unconfigured, so it never surfaces a button that always fails.
 */
@Injectable()
export class TopicProposalsService {
  private readonly logger = new Logger(TopicProposalsService.name);
  private readonly recentDays: number;
  private readonly maxItems: number;
  private readonly minClusterSize: number;
  private readonly similarity: number;
  private readonly coveredConfidence: number;
  private readonly maxPerRun: number;
  private readonly suppressJaccard: number;

  constructor(
    config: ConfigService,
    private readonly inbox: InboxService,
    private readonly topics: TopicsService,
    private readonly embeddings: EmbeddingSearchService,
    @Inject(TOPIC_PROPOSAL_LABEL_PROVIDER)
    private readonly labeler: TopicProposalLabelProvider,
    @InjectRepository(TopicProposalEntity)
    private readonly proposals: Repository<TopicProposalEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly assignments: Repository<ItemTopicEntity>,
  ) {
    this.recentDays = num(config, 'TOPIC_PROPOSALS_RECENT_DAYS', 30);
    this.maxItems = num(config, 'TOPIC_PROPOSALS_MAX_ITEMS', 200);
    this.minClusterSize = num(config, 'TOPIC_PROPOSALS_MIN_CLUSTER_SIZE', 4);
    this.similarity = num(config, 'TOPIC_PROPOSALS_SIMILARITY', 0.82);
    this.coveredConfidence = num(config, 'TOPIC_PROPOSALS_COVERED_CONFIDENCE', 0.5);
    this.maxPerRun = num(config, 'TOPIC_PROPOSALS_MAX_PER_RUN', 5);
    this.suppressJaccard = num(config, 'TOPIC_PROPOSALS_SUPPRESS_JACCARD', 0.5);
  }

  /** Feature runs only when embeddings AND the labeling LLM are both configured. */
  get enabled(): boolean {
    return this.embeddings.enabled && this.labeler.enabled;
  }

  /** The pending proposals surfaced in the topics UI, newest first. */
  async listProposals(userId: string): Promise<TopicProposalListResponse> {
    const rows = await this.proposals.find({
      where: { userId, status: 'pending' },
      order: { createdAt: 'DESC' },
    });
    return { proposals: rows.map(toProposalDto), enabled: this.enabled };
  }

  /**
   * (Re)generate proposals: cluster recent uncovered items, label the largest
   * new clusters, and persist them as pending. Suppresses clusters the user
   * already dismissed/accepted and clusters already pending. No-ops (returning
   * the current list) when the feature is disabled. Returns the refreshed list.
   */
  async generate(userId: string): Promise<TopicProposalListResponse> {
    if (!this.enabled) return this.listProposals(userId);

    const candidateIds = await this.recentUncoveredItemIds(userId);
    if (candidateIds.length < this.minClusterSize) return this.listProposals(userId);

    // Cluster in recency order (newest first), so leader clusters seed from the
    // most recent items and the fingerprint of a growing theme stays stable-ish.
    const centroids = await this.embeddings.itemCentroids(userId, candidateIds);
    const byId = new Map(centroids.map((c) => [c.inboxItemId, c.vector]));
    const ordered: ClusterInput[] = [];
    for (const id of candidateIds) {
      const vector = byId.get(id);
      if (vector) ordered.push({ inboxItemId: id, vector });
    }

    const clusters = clusterItems(ordered, {
      threshold: this.similarity,
      minSize: this.minClusterSize,
    });
    if (clusters.length === 0) return this.listProposals(userId);

    const existing = await this.proposals.find({ where: { userId } });
    // Clusters the user already ruled on (dismissed or accepted) — never re-propose.
    const suppressed = existing
      .filter((p) => p.status === 'dismissed' || p.status === 'accepted')
      .map((p) => p.memberItemIds);
    // Clusters already awaiting a decision — don't duplicate.
    const pending = existing.filter((p) => p.status === 'pending').map((p) => p.memberItemIds);

    let budget = this.maxPerRun;
    for (const cluster of clusters) {
      if (budget <= 0) break;
      const overlaps = (sets: string[][]) =>
        sets.some((s) => jaccard(cluster.memberItemIds, s) >= this.suppressJaccard);
      if (overlaps(suppressed) || overlaps(pending)) continue;

      const labeled = await this.labelCluster(userId, cluster.memberItemIds);
      if (!labeled) continue;

      const sampleItemIds = cluster.memberItemIds.slice(0, SAMPLE_ITEMS);
      await this.proposals.save(
        this.proposals.create({
          userId,
          fingerprint: clusterFingerprint(cluster.memberItemIds),
          label: labeled.label,
          description: labeled.description,
          itemCount: cluster.memberItemIds.length,
          memberItemIds: cluster.memberItemIds,
          sampleItemIds,
          status: 'pending',
          acceptedTopicId: null,
        }),
      );
      // Track the just-created cluster so a near-duplicate later in the run is skipped.
      pending.push(cluster.memberItemIds);
      budget -= 1;
    }

    return this.listProposals(userId);
  }

  /**
   * Accept a proposal: create the topic in the taxonomy and reclassify the
   * cluster's items against the now-extended taxonomy via the existing per-item
   * topics pipeline (no new pipeline is invented). Returns the created topic.
   */
  async accept(userId: string, proposalId: string): Promise<TopicDto> {
    const proposal = await this.proposals.findOne({ where: { id: proposalId, userId } });
    if (!proposal) throw new NotFoundException('proposal not found');
    if (proposal.status !== 'pending') {
      throw new ConflictException('proposal has already been resolved');
    }
    if (!this.topics.enabled) {
      throw new BadRequestException(
        'topic classification is not configured (set TOPICS_API_KEY, or TOPICS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }

    const topic = await this.topics.createTopic(userId, {
      name: proposal.label,
      description: proposal.description ?? undefined,
    });

    proposal.status = 'accepted';
    proposal.acceptedTopicId = topic.id;
    await this.proposals.save(proposal);

    // Reclassify the cluster's members so they pick up the new topic. Reuses the
    // existing per-item enqueue; items deleted or without classifiable content
    // are skipped rather than failing the accept.
    let reclassified = 0;
    for (const inboxItemId of proposal.memberItemIds) {
      const item = await this.inbox.getItemById(inboxItemId);
      if (!item || item.userId !== userId) continue;
      if (!buildTopicContent(item)) continue;
      try {
        await this.topics.enqueueTopics(inboxItemId);
        reclassified += 1;
      } catch (err) {
        this.logger.warn(
          `failed to enqueue reclassification for item ${inboxItemId}: ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(
      `accepted proposal ${proposalId} -> topic ${topic.id}; reclassifying ${reclassified} item(s)`,
    );
    return topic;
  }

  /** Dismiss a proposal — its row is retained so the cluster is not re-proposed. */
  async dismiss(userId: string, proposalId: string): Promise<void> {
    const proposal = await this.proposals.findOne({ where: { id: proposalId, userId } });
    if (!proposal) throw new NotFoundException('proposal not found');
    if (proposal.status === 'accepted') {
      throw new ConflictException('an accepted proposal cannot be dismissed');
    }
    if (proposal.status === 'dismissed') return;
    proposal.status = 'dismissed';
    await this.proposals.save(proposal);
  }

  /**
   * Recent items not already well-covered by the taxonomy, newest first. An item
   * is "covered" when it carries any topic assignment at/above the confidence
   * threshold, so clustering focuses on genuinely un-triaged material.
   */
  private async recentUncoveredItemIds(userId: string): Promise<string[]> {
    const since = new Date(Date.now() - this.recentDays * 24 * 60 * 60 * 1000);
    const rows = await this.items
      .createQueryBuilder('item')
      .select('item.id', 'id')
      .where('item.userId = :userId', { userId })
      .andWhere('item.ingestedAt >= :since', { since })
      .andWhere((qb) => {
        const covered = qb
          .subQuery()
          .select('1')
          .from(ItemTopicEntity, 'it')
          .where('it.inboxItemId = item.id')
          .andWhere('it.confidence >= :covered')
          .getQuery();
        return `NOT EXISTS ${covered}`;
      })
      .setParameter('covered', this.coveredConfidence)
      .orderBy('item.ingestedAt', 'DESC')
      .addOrderBy('item.id', 'DESC')
      .limit(this.maxItems)
      .getRawMany<{ id: string }>();
    return rows.map((r) => r.id);
  }

  /** Fetch sample excerpts for a cluster and ask the labeler to name it. */
  private async labelCluster(
    userId: string,
    memberItemIds: string[],
  ): Promise<{ label: string; description: string | null } | null> {
    const samples: string[] = [];
    let language: string | undefined;
    for (const id of memberItemIds.slice(0, SAMPLE_ITEMS)) {
      const item = await this.inbox.getItemById(id);
      if (!item || item.userId !== userId) continue;
      const content = buildTopicContent(item);
      if (!content) continue;
      samples.push(content.content.slice(0, SAMPLE_CHARS));
      if (!language && content.language) language = content.language;
    }
    if (samples.length === 0) return null;

    try {
      const result = await this.labeler.label({ samples, language });
      const label = result.label.trim();
      if (!label) return null;
      return { label, description: result.description };
    } catch (err) {
      this.logger.warn(`cluster labeling failed: ${(err as Error).message}`);
      return null;
    }
  }
}

function toProposalDto(row: TopicProposalEntity): TopicProposalDto {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    itemCount: row.itemCount,
    sampleItemIds: row.sampleItemIds ?? [],
    status: row.status,
    acceptedTopicId: row.acceptedTopicId,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function num(config: ConfigService, key: string, fallback: number): number {
  const parsed = Number(config.get<string>(key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runWithAiAudit } from '@plaudern/audit';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import { EmbeddingSearchService } from '@plaudern/embeddings';
import {
  InboxItemEntity,
  ItemTopicEntity,
  TopicProposalEntity,
  TopicProposalRunEntity,
} from '@plaudern/persistence';
import { buildTopicContent } from './topic-context';
import {
  clusterFingerprint,
  clusterItems,
  cosineSimilarity,
  jaccard,
  type ClusterInput,
} from './topic-proposals.clustering';
import {
  TOPIC_PROPOSAL_LABEL_PROVIDER,
  type TopicProposalLabelProvider,
} from './topic-proposals.provider';
import type { TopicProposalGenerationJob } from './topic-proposals.job';

/** Number of member excerpts sent to the labeler and stored for the UI preview. */
const SAMPLE_ITEMS = 6;
/** Per-sample excerpt length — enough to name the theme, small enough to stay cheap. */
const SAMPLE_CHARS = 600;

/**
 * How many resolved (accepted/dismissed) proposals to retain per user for
 * suppression (JJ-69). generate() used to load ALL of a user's rows and run
 * O(clusters x history) Jaccard every run; unbounded retention meant that scan
 * grew forever. We keep only the newest N resolved rows: the suppression query
 * reads at most this many, and a prune after each run trims the rest.
 *
 * TRADEOFF: a dismissed cluster whose row has aged past the newest N resolutions
 * can, in principle, be re-proposed if it later regrows. N is deliberately large
 * so that only happens after a great many newer decisions — long after the old
 * dismissal is still meaningful — and the row is only ever pruned once at least
 * N NEWER resolved rows exist, so an active suppression is never dropped for a
 * still-current cluster. Pending rows are never pruned (they are live UI state,
 * and already bounded per run by the labeling budget).
 */
export const DEFAULT_PROPOSAL_RETENTION = 200;

/** A resolved cluster the user already ruled on — the unit of suppression. */
interface Suppressor {
  memberItemIds: string[];
  centroid: number[] | null;
}

/**
 * Executes one taxonomy-proposal generation run (JJ-69). Moved off the request
 * path onto the queue/worker because labeling up to `maxPerRun` clusters with
 * inline LLM calls could take minutes and time out behind a proxy. Clusters the
 * user's recent uncovered item embeddings, suppresses clusters already ruled on
 * (member-id Jaccard OR — for rows with a stored centroid — centroid cosine, so
 * a regrown dismissed cluster can't slip past), labels the survivors with the
 * LLM, and persists them as pending. Shared by the inline and BullMQ queues.
 *
 * The LLM labeling call stays wrapped in `runWithAiAudit` under the owning
 * user's id and resolves per-user provider config via the labeler adapter,
 * exactly as it did on the request path — the call MOVED, its context did not.
 */
@Injectable()
export class TopicProposalGenerationProcessor {
  private readonly logger = new Logger(TopicProposalGenerationProcessor.name);
  private readonly recentDays: number;
  private readonly maxItems: number;
  private readonly minClusterSize: number;
  private readonly similarity: number;
  private readonly coveredConfidence: number;
  private readonly maxPerRun: number;
  private readonly suppressJaccard: number;
  private readonly suppressCosine: number;
  private readonly retention: number;

  constructor(
    config: ConfigService,
    private readonly inbox: InboxService,
    private readonly embeddings: EmbeddingSearchService,
    @Inject(TOPIC_PROPOSAL_LABEL_PROVIDER)
    private readonly labeler: TopicProposalLabelProvider,
    @InjectRepository(TopicProposalEntity)
    private readonly proposals: Repository<TopicProposalEntity>,
    @InjectRepository(TopicProposalRunEntity)
    private readonly runs: Repository<TopicProposalRunEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
  ) {
    this.recentDays = num(config, 'TOPIC_PROPOSALS_RECENT_DAYS', 30);
    this.maxItems = num(config, 'TOPIC_PROPOSALS_MAX_ITEMS', 200);
    this.minClusterSize = num(config, 'TOPIC_PROPOSALS_MIN_CLUSTER_SIZE', 4);
    this.similarity = num(config, 'TOPIC_PROPOSALS_SIMILARITY', 0.82);
    this.coveredConfidence = num(config, 'TOPIC_PROPOSALS_COVERED_CONFIDENCE', 0.5);
    this.maxPerRun = num(config, 'TOPIC_PROPOSALS_MAX_PER_RUN', 5);
    this.suppressJaccard = num(config, 'TOPIC_PROPOSALS_SUPPRESS_JACCARD', 0.5);
    this.suppressCosine = num(config, 'TOPIC_PROPOSALS_SUPPRESS_COSINE', 0.95);
    this.retention = num(config, 'TOPIC_PROPOSALS_RETENTION', DEFAULT_PROPOSAL_RETENTION);
  }

  /**
   * Claim the user's queued run, generate, and record the outcome. Race-safe:
   * the queued -> processing flip is a guarded conditional update, so only the
   * one worker that flips the row proceeds (a redelivered/duplicate job no-ops).
   */
  async process(job: TopicProposalGenerationJob): Promise<void> {
    const { userId } = job;
    const claimed = await this.runs
      .createQueryBuilder()
      .update()
      .set({ status: 'processing' })
      .where('userId = :userId AND status = :queued', { userId, queued: 'queued' })
      .execute();
    if (claimed.affected !== 1) return; // not queued (already handled) — nothing to do.

    try {
      const created = await this.generate(userId);
      // Terminal writes are conditional on still owning the row (`processing`):
      // if this run went stale and a fresh generate took the row over (flipped
      // it back to `queued` — see TopicProposalsService.startRun), a zombie
      // slow-but-alive run must not clobber the fresh run's status.
      await this.runs.update(
        { userId, status: 'processing' },
        { status: 'succeeded', proposalsCreated: created, error: null },
      );
      this.logger.log(`generated ${created} proposal(s) for user ${userId}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`proposal generation failed for user ${userId}: ${message}`);
      await this.runs.update({ userId, status: 'processing' }, { status: 'failed', error: message });
      throw err;
    }
  }

  /** Cluster recent uncovered items, suppress, label survivors, persist. */
  private async generate(userId: string): Promise<number> {
    const candidateIds = await this.recentUncoveredItemIds(userId);
    if (candidateIds.length < this.minClusterSize) return 0;

    // Cluster in recency order (newest first), so leader clusters seed from the
    // most recent items and the fingerprint of a growing theme stays stable-ish.
    const centroids = await this.embeddings.itemCentroids(userId, candidateIds);
    const byId = new Map(centroids.map((c) => [c.inboxItemId, c.vector]));
    const ordered: ClusterInput[] = [];
    for (const id of candidateIds) {
      const vector = byId.get(id);
      if (vector) ordered.push({ inboxItemId: id, vector });
    }

    const { clusters, mismatchedDimensionCount } = clusterItems(ordered, {
      threshold: this.similarity,
      minSize: this.minClusterSize,
    });
    if (mismatchedDimensionCount > 0) {
      // An embedding provider/dimension switch mid-history; those items can't
      // be compared against the current run's vectors, so they sat out.
      this.logger.warn(
        `skipped ${mismatchedDimensionCount} item(s) with mismatched embedding dimensions for user ${userId}`,
      );
    }
    if (clusters.length === 0) return 0;

    // Suppression set: the newest N resolved (dismissed/accepted) rows — bounded
    // and index-backed, replacing the old "load every row" scan (JJ-69).
    const resolvedRows = await this.proposals.find({
      where: { userId, status: In(['dismissed', 'accepted']) },
      order: { createdAt: 'DESC' },
      take: this.retention,
    });
    const suppressed: Suppressor[] = resolvedRows.map((r) => ({
      memberItemIds: r.memberItemIds,
      centroid: r.centroid,
    }));
    // Clusters already awaiting a decision — don't duplicate them this run.
    const pendingRows = await this.proposals.find({ where: { userId, status: 'pending' } });
    const pending: Suppressor[] = pendingRows.map((r) => ({
      memberItemIds: r.memberItemIds,
      centroid: r.centroid,
    }));

    let created = 0;
    let budget = this.maxPerRun;
    for (const cluster of clusters) {
      if (budget <= 0) break;
      if (this.isSuppressed(cluster, suppressed) || this.isSuppressed(cluster, pending)) continue;

      const labeled = await this.labelCluster(userId, cluster.memberItemIds);
      if (!labeled) continue;

      const sampleItemIds = cluster.memberItemIds.slice(0, SAMPLE_ITEMS);
      try {
        await this.proposals.save(
          this.proposals.create({
            userId,
            fingerprint: clusterFingerprint(cluster.memberItemIds),
            label: labeled.label,
            description: labeled.description,
            itemCount: cluster.memberItemIds.length,
            memberItemIds: cluster.memberItemIds,
            sampleItemIds,
            centroid: cluster.centroid,
            status: 'pending',
            acceptedTopicId: null,
          }),
        );
      } catch (err) {
        // Lost a race on the (userId, fingerprint) unique index — a concurrent
        // generate already stored this exact cluster; skip it.
        if (!isUniqueViolation(err)) throw err;
        continue;
      }
      // Track the just-created cluster so a near-duplicate later in the run is skipped.
      pending.push({ memberItemIds: cluster.memberItemIds, centroid: cluster.centroid });
      created += 1;
      budget -= 1;
    }

    await this.pruneResolved(userId);
    return created;
  }

  /**
   * Whether a fresh cluster overlaps one the user already ruled on — by member
   * Jaccard (a single item drifting in can't resurrect an old cluster) OR, for
   * rows that stored a centroid, by centroid cosine (JJ-69). The centroid check
   * catches a dismissed cluster that regrew past 2x its old size: its member set
   * barely intersects the old one (Jaccard fails) but its direction is nearly
   * unchanged. Legacy rows without a centroid fall back to Jaccard-only.
   */
  private isSuppressed(
    cluster: { memberItemIds: string[]; centroid: number[] },
    against: Suppressor[],
  ): boolean {
    for (const s of against) {
      if (jaccard(cluster.memberItemIds, s.memberItemIds) >= this.suppressJaccard) return true;
      if (s.centroid && cosineSimilarity(cluster.centroid, s.centroid) >= this.suppressCosine) {
        return true;
      }
    }
    return false;
  }

  /**
   * Trim resolved (accepted/dismissed) rows down to the newest `retention` per
   * user (JJ-69). Plain `createdAt < cutoff` predicate re-evaluated against the
   * live table, so it is race-safe (mirrors pruneTopicDocumentHistory): it only
   * ever deletes rows strictly older than the retention-th newest, and no-ops
   * until there are more than `retention` resolved rows. Best-effort — a prune
   * hiccup must not fail an otherwise-successful generation.
   */
  private async pruneResolved(userId: string): Promise<void> {
    try {
      const keep = await this.proposals.find({
        where: { userId, status: In(['dismissed', 'accepted']) },
        order: { createdAt: 'DESC' },
        take: this.retention,
        select: { id: true, createdAt: true },
      });
      if (keep.length < this.retention) return;
      const cutoff = keep[keep.length - 1].createdAt;
      const res = await this.proposals.delete({
        userId,
        status: In(['dismissed', 'accepted']),
        createdAt: LessThan(cutoff),
      });
      if (res.affected) {
        this.logger.log(`pruned ${res.affected} old resolved proposal(s) for user ${userId}`);
      }
    } catch (err) {
      this.logger.warn(
        `failed to prune resolved proposals for user ${userId}: ${(err as Error).message}`,
      );
    }
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
      const result = await runWithAiAudit(
        { userId, kind: 'topic_proposals' },
        () => this.labeler.label(userId, { samples, language }),
      );
      const label = result.label.trim();
      if (!label) return null;
      return { label, description: result.description };
    } catch (err) {
      this.logger.warn(`cluster labeling failed: ${(err as Error).message}`);
      return null;
    }
  }
}

function num(config: ConfigService, key: string, fallback: number): number {
  const parsed = Number(config.get<string>(key, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505 (unique_violation), better-sqlite3 a
 * SQLITE_CONSTRAINT* code / "UNIQUE constraint failed" message. Anything else
 * must propagate. (Same pattern as the commitments/tasks persistence.)
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

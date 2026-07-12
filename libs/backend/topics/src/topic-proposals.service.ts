import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiConfigService } from '@plaudern/ai-config';
import { InboxService } from '@plaudern/inbox';
import { EmbeddingSearchService } from '@plaudern/embeddings';
import type { TopicDto, TopicProposalDto, TopicProposalListResponse } from '@plaudern/contracts';
import {
  TopicEntity,
  TopicProposalEntity,
  TopicProposalRunEntity,
} from '@plaudern/persistence';
import { TopicsService } from './topics.service';
import { buildTopicContent } from './topic-context';
import {
  TOPIC_PROPOSAL_GENERATION_QUEUE,
  type TopicProposalGenerationQueue,
} from './topic-proposals.job';

/**
 * Proposes taxonomy extensions from embedding clusters (JJ-64). On demand
 * (a "suggest topics" trigger from the topics UI) it clusters the user's recent
 * item embeddings, excludes items already well-covered by the existing taxonomy,
 * labels each new cluster with the LLM, and stores pending proposals. Accepting
 * one creates the topic and reclassifies the cluster's items via the existing
 * per-item topics pipeline; dismissed/accepted rows are retained (bounded, JJ-69)
 * so their clusters are not re-proposed.
 *
 * The heavy clustering + labeling pass runs on the queue/worker
 * (`TopicProposalGenerationProcessor`), not inline on the HTTP request (JJ-69):
 * labeling up to N clusters could take minutes and time out behind a proxy. This
 * service owns the request-side concerns — the enabled gate, the race-safe
 * in-flight run guard, the read model (pending proposals + run status), and the
 * accept/dismiss transitions.
 *
 * The whole feature degrades to disabled when either embeddings or the labeling
 * LLM are unconfigured, so it never surfaces a button that always fails.
 */
@Injectable()
export class TopicProposalsService {
  private readonly logger = new Logger(TopicProposalsService.name);

  constructor(
    private readonly inbox: InboxService,
    private readonly topics: TopicsService,
    private readonly embeddings: EmbeddingSearchService,
    private readonly aiConfig: AiConfigService,
    @Inject(TOPIC_PROPOSAL_GENERATION_QUEUE)
    private readonly queue: TopicProposalGenerationQueue,
    @InjectRepository(TopicProposalEntity)
    private readonly proposals: Repository<TopicProposalEntity>,
    @InjectRepository(TopicProposalRunEntity)
    private readonly runs: Repository<TopicProposalRunEntity>,
  ) {}

  /** Feature runs only when embeddings AND the labeling LLM are both configured. */
  async isEnabled(userId: string): Promise<boolean> {
    return (
      (await this.embeddings.isEnabled(userId)) &&
      (await this.aiConfig.isEnabled(userId, 'topics'))
    );
  }

  /**
   * The pending proposals surfaced in the topics UI, newest first, plus the
   * async generation-run status the UI polls (JJ-69).
   */
  async listProposals(userId: string): Promise<TopicProposalListResponse> {
    const [rows, run, enabled] = await Promise.all([
      this.proposals.find({
        where: { userId, status: 'pending' },
        order: { createdAt: 'DESC' },
      }),
      this.runs.findOne({ where: { userId } }),
      this.isEnabled(userId),
    ]);
    return {
      proposals: rows.map(toProposalDto),
      enabled,
      generation: {
        status: run?.status ?? null,
        error: run?.status === 'failed' ? run.error ?? null : null,
        updatedAt: run ? iso(run.updatedAt) : null,
      },
    };
  }

  /**
   * Trigger a fresh clustering + labeling pass on the queue/worker, then return
   * the current list + run status (JJ-69). Enqueue-and-return: the endpoint
   * responds immediately (202) and the UI polls `listProposals` until the run
   * settles. No-ops (returning the current list) when the feature is disabled or
   * a run is already IN FLIGHT for the user — a double-click coalesces onto the
   * running one instead of enqueuing a duplicate.
   */
  async generate(userId: string): Promise<TopicProposalListResponse> {
    if (await this.isEnabled(userId)) {
      await this.startRun(userId);
    }
    return this.listProposals(userId);
  }

  /**
   * Admit a fresh generation run, race-safely (JJ-69). The run is one row per
   * user whose status is the guard:
   *  - a terminal row (succeeded/failed) is flipped back to `queued` by a guarded
   *    conditional UPDATE — only the one caller whose update affects a row wins
   *    and enqueues;
   *  - no row yet: INSERT one (unique `userId` index makes a concurrent double
   *    insert lose cleanly, and that loser coalesces);
   *  - an in-flight row (queued/processing): coalesce — return without enqueuing.
   *
   * This is the "conditional UPDATE/insert guard, not save()-by-PK" the double-
   * click needs: it works identically on sqlite and Postgres.
   */
  private async startRun(userId: string): Promise<void> {
    const flipped = await this.runs
      .createQueryBuilder()
      .update()
      .set({ status: 'queued', error: null, proposalsCreated: 0 })
      .where('userId = :userId AND status IN (:...terminal)', {
        userId,
        terminal: ['succeeded', 'failed'],
      })
      .execute();
    if (flipped.affected === 1) {
      await this.queue.enqueue({ userId });
      return;
    }

    // Nothing terminal to flip: either a run is in flight, or there's no row yet.
    const existing = await this.runs.findOne({ where: { userId } });
    if (existing) return; // queued/processing — coalesce onto the in-flight run.

    try {
      await this.runs.insert({ userId, status: 'queued', error: null, proposalsCreated: 0 });
    } catch (err) {
      // Lost the unique-userId race with a concurrent first trigger; that run
      // will cover this request too, so coalesce.
      if (isUniqueViolation(err)) return;
      throw err;
    }
    await this.queue.enqueue({ userId });
  }

  /**
   * Accept a proposal: create the topic in the taxonomy and reclassify the
   * cluster's items against the now-extended taxonomy via the existing per-item
   * topics pipeline (no new pipeline is invented). Returns the created topic.
   *
   * Claim + create run in one transaction, and the claim is a guarded
   * conditional update (`... WHERE status = 'pending'`): of two concurrent
   * accepts (multi-tab) exactly one flips the row and creates the topic — the
   * loser affects zero rows and gets the same Conflict an already-resolved
   * proposal would. A crash mid-accept rolls the topic back with the claim, so
   * no orphan topic can be left behind a still-pending proposal.
   */
  async accept(userId: string, proposalId: string): Promise<TopicDto> {
    const proposal = await this.proposals.findOne({ where: { id: proposalId, userId } });
    if (!proposal) throw new NotFoundException('proposal not found');
    if (proposal.status !== 'pending') {
      throw new ConflictException('proposal has already been resolved');
    }
    if (!(await this.topics.isEnabled(userId))) {
      throw new BadRequestException(
        'topic classification is not configured (assign a provider to the topics capability in Settings → AI)',
      );
    }

    const topic = await this.proposals.manager.transaction(async (em) => {
      const claimed = await em
        .getRepository(TopicProposalEntity)
        .update({ id: proposalId, userId, status: 'pending' }, { status: 'accepted' });
      if (!claimed.affected) {
        throw new ConflictException('proposal has already been resolved');
      }
      const topicsRepo = em.getRepository(TopicEntity);
      const row = await topicsRepo.save(
        topicsRepo.create({
          userId,
          name: proposal.label,
          description: proposal.description,
          archived: false,
        }),
      );
      await em
        .getRepository(TopicProposalEntity)
        .update({ id: proposalId }, { acceptedTopicId: row.id });
      return toTopicDto(row);
    });

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

/** Mirrors TopicsService's DTO mapping for the topic created inside accept()'s transaction. */
function toTopicDto(row: TopicEntity): TopicDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archived: row.archived,
    createdAt: iso(row.createdAt)!,
    updatedAt: iso(row.updatedAt)!,
  };
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
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

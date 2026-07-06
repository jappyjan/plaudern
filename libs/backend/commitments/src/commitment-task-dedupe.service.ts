import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { EmbeddingProvider } from '@plaudern/embeddings';
import {
  CommitmentEntity,
  ExtractedPayloadEntity,
  TaskCitationEntity,
  TaskEntity,
} from '@plaudern/persistence';

/**
 * DI token for the embedding provider the task/commitment dedupe uses. Bound in
 * `CommitmentsModule` to the same shared OpenAI-compatible embeddings provider
 * the task dedupe uses (reads EMBEDDINGS_*), so the semantic path lights up
 * automatically wherever task dedupe already works; tests override it with a
 * fake.
 */
export const COMMITMENT_DEDUPE_EMBEDDING_PROVIDER = Symbol(
  'COMMITMENT_DEDUPE_EMBEDDING_PROVIDER',
);

/**
 * Cosine-similarity cutoff above which an `owed_by_me` commitment and a task are
 * "the same intention". Lower than the task↔task dedupe threshold (0.85) on
 * purpose: the two extractors phrase and even TRANSLATE the same action
 * differently (a German promise vs. an English task title), so cross-lingual
 * paraphrases land a little further apart. Over-merging here is low-harm — the
 * task still shows the action — while under-merging leaves the visible
 * duplicate, so the default biases slightly toward merging.
 */
const DEFAULT_DEDUPE_THRESHOLD = 0.8;

/**
 * Reconciles an item's `owed_by_me` commitments against the item's tasks so one
 * intention is not shown twice (task-commitment-duplicates). Runs AFTER the
 * commitments extractor persists — its `tasks: settled` DAG dependency
 * guarantees the item's tasks already exist, so this is a plain read of the
 * task rows the tasks extractor deduped, with no cross-extractor race.
 *
 * A commitment matches a task when their normalized text is identical OR their
 * embeddings are near (cosine ≥ threshold). On a match the commitment is stamped
 * with the winning `tasks.id` (`duplicatesTaskId`); the commitment read models
 * hide stamped rows, so the item detail and the open-loops ledger surface the
 * richer task once instead of the task-and-commitment pair. Only OPEN
 * `owed_by_me` rows are touched: `owed_to_me` promises never overlap a
 * self-directed task, and a commitment the user already actioned is left as the
 * record of a handled obligation.
 *
 * Lives in its OWN provider (not CommitmentsService) so the processor can reach
 * it without an edge back to the service — the same acyclicity rule the
 * persistence provider follows.
 */
@Injectable()
export class CommitmentTaskDedupeService {
  private readonly logger = new Logger(CommitmentTaskDedupeService.name);
  private readonly threshold: number;

  constructor(
    @InjectRepository(CommitmentEntity)
    private readonly commitments: Repository<CommitmentEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @InjectRepository(TaskCitationEntity)
    private readonly citations: Repository<TaskCitationEntity>,
    @InjectRepository(TaskEntity)
    private readonly tasks: Repository<TaskEntity>,
    @Inject(COMMITMENT_DEDUPE_EMBEDDING_PROVIDER)
    private readonly embeddings: EmbeddingProvider,
    config: ConfigService,
  ) {
    const raw = Number(config.get<string>('COMMITMENTS_TASK_DEDUPE_THRESHOLD', ''));
    this.threshold = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_DEDUPE_THRESHOLD;
  }

  /**
   * Re-stamp the item's OPEN `owed_by_me` commitments against its tasks. Safe to
   * call on every extraction: it recomputes each row's match from scratch, so a
   * commitment that no longer resembles any task has its stale stamp cleared.
   */
  async reconcile(userId: string, inboxItemId: string): Promise<void> {
    const open = await this.commitments.find({
      where: { userId, inboxItemId, direction: 'owed_by_me', status: 'open' },
    });
    if (open.length === 0) return;

    const tasks = await this.itemTasks(inboxItemId);
    if (tasks.length === 0) {
      // No tasks to merge into — drop any stamp a previous run left behind.
      await this.clearStamps(open);
      return;
    }

    const vectors = await this.embed(userId, open.map((c) => c.description));

    const dirty: CommitmentEntity[] = [];
    for (let i = 0; i < open.length; i++) {
      const commitment = open[i];
      const match = this.bestMatch(commitment.description, vectors[i], tasks);
      const next = match?.id ?? null;
      if (commitment.duplicatesTaskId !== next) {
        commitment.duplicatesTaskId = next;
        dirty.push(commitment);
      }
    }
    if (dirty.length > 0) {
      await this.commitments.save(dirty);
      const merged = dirty.filter((c) => c.duplicatesTaskId).length;
      this.logger.log(
        `reconciled ${dirty.length} commitment(s) for item ${inboxItemId} (${merged} merged into a task)`,
      );
    }
  }

  /** The best task a commitment collapses into: exact text, else nearest embedding. */
  private bestMatch(
    description: string,
    vector: number[] | null,
    tasks: TaskCandidate[],
  ): TaskCandidate | null {
    const normalized = normalizeTitle(description);
    const exact = tasks.find((t) => t.normalizedTitle === normalized);
    if (exact) return exact;

    if (!vector) return null;
    let best: { task: TaskCandidate; score: number } | null = null;
    for (const task of tasks) {
      if (!task.embedding || task.embedding.length !== vector.length) continue;
      const score = cosineSimilarity(vector, task.embedding);
      if (!best || score > best.score) best = { task, score };
    }
    return best && best.score >= this.threshold ? best.task : null;
  }

  /**
   * The tasks the item was linked to by its LATEST succeeded `tasks` extraction
   * — the same generation the tasks read model shows for the item — carrying the
   * title/embedding the dedupe needs.
   */
  private async itemTasks(inboxItemId: string): Promise<TaskCandidate[]> {
    const extractions = await this.extractions.find({
      where: { inboxItemId, kind: 'tasks', status: 'succeeded' },
    });
    if (extractions.length === 0) return [];
    const latest = extractions.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));

    const citations = await this.citations.find({ where: { extractionId: latest.id } });
    const taskIds = [...new Set(citations.map((c) => c.taskId))];
    if (taskIds.length === 0) return [];

    const rows = await this.tasks.find({ where: { id: In(taskIds) } });
    return rows.map((r) => ({
      id: r.id,
      normalizedTitle: r.normalizedTitle,
      embedding: r.embedding,
    }));
  }

  /** Embed commitment descriptions; a null per entry when embeddings are unavailable. */
  private async embed(userId: string, texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0 || !(await this.embeddings.isEnabled(userId))) {
      return texts.map(() => null);
    }
    try {
      const { vectors } = await this.embeddings.embed(userId, texts);
      return texts.map((_, i) => (vectors[i]?.length ? vectors[i] : null));
    } catch (err) {
      this.logger.warn(
        `commitment dedupe embedding failed, falling back to text match: ${(err as Error).message}`,
      );
      return texts.map(() => null);
    }
  }

  private async clearStamps(rows: CommitmentEntity[]): Promise<void> {
    const dirty = rows.filter((r) => r.duplicatesTaskId !== null);
    if (dirty.length === 0) return;
    for (const row of dirty) row.duplicatesTaskId = null;
    await this.commitments.save(dirty);
  }
}

/** A task reduced to what the dedupe compares against. */
interface TaskCandidate {
  id: string;
  normalizedTitle: string;
  embedding: number[] | null;
}

/**
 * Normalization key matching the task registry's `normalizeTitle` exactly
 * (lowercased, whitespace-collapsed, trailing punctuation dropped) so an
 * exact-text match here lines up with the `tasks.normalizedTitle` the tasks
 * extractor stored. Replicated rather than imported to keep the commitments
 * module from depending on the tasks module.
 */
export function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,]+$/g, '')
    .trim();
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

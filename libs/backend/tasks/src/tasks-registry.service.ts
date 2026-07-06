import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  ItemTasksResponse,
  TaskCitationDto,
  TaskDto,
  TaskExtractionPayload,
  TaskStatus,
} from '@plaudern/contracts';
import { taskExtractionPayloadSchema } from '@plaudern/contracts';
import type { EmbeddingProvider } from '@plaudern/embeddings';
import { SelfProfileService } from '@plaudern/inbox';
import {
  ExtractedPayloadEntity,
  TaskCitationEntity,
  TaskEntity,
} from '@plaudern/persistence';

/**
 * DI token for the embedding provider the dedupe uses. Bound in `TasksModule` to
 * the shared OpenAI-compatible embeddings provider (reads EMBEDDINGS_*), so
 * "when embeddings are configured" the semantic path lights up automatically;
 * tests override it with a fake.
 */
export const TASK_DEDUPE_EMBEDDING_PROVIDER = Symbol('TASK_DEDUPE_EMBEDDING_PROVIDER');

/** Default cosine-similarity cutoff above which two task titles are "the same". */
const DEFAULT_DEDUPE_THRESHOLD = 0.85;

/**
 * Upper bound on candidate tasks ingested per extraction — a defensive cap on
 * unbounded LLM output (a hallucinating model must not flood the task list).
 */
export const MAX_TASKS_PER_EXTRACTION = 50;

/** A resolved candidate task ready to be deduped into the list. */
export interface TaskCandidate {
  title: string;
  dueDate: string | null;
  quote: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

/**
 * Owns the per-user task list (JJ-35): deduplicating extracted candidate tasks
 * into `tasks` rows and recording `task_citations` edges. Dedupe is SEMANTIC
 * when the embeddings provider is configured — the candidate title is embedded
 * and compared against the user's OPEN tasks via pgvector cosine distance
 * (native `<=>` on Postgres, in-JS cosine on the sqlite test DB) — and falls
 * back to normalized-text exact match otherwise. Also serves the read models
 * (list, an item's citations) and the status mutation.
 *
 * Citations are keyed to the `tasks` extraction that produced them; the read
 * models restrict citation aggregates to each item's LATEST succeeded `tasks`
 * extraction, so append-only reprocessing supersedes old citations without ever
 * duplicating a task.
 */
@Injectable()
export class TasksRegistryService {
  private readonly logger = new Logger(TasksRegistryService.name);
  private readonly threshold: number;

  constructor(
    @InjectRepository(TaskEntity)
    private readonly tasks: Repository<TaskEntity>,
    @InjectRepository(TaskCitationEntity)
    private readonly citations: Repository<TaskCitationEntity>,
    @InjectRepository(ExtractedPayloadEntity)
    private readonly extractions: Repository<ExtractedPayloadEntity>,
    @Inject(TASK_DEDUPE_EMBEDDING_PROVIDER)
    private readonly embeddings: EmbeddingProvider,
    config: ConfigService,
    private readonly selfProfile: SelfProfileService,
  ) {
    const raw = Number(config.get<string>('TASKS_DEDUPE_THRESHOLD', ''));
    this.threshold = Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_DEDUPE_THRESHOLD;
  }

  /**
   * Dedupe a batch of candidate tasks into the user's list and append one
   * citation per distinct task for this extraction. Returns the number of
   * distinct tasks the item was linked to. Each new task is persisted before the
   * next candidate is processed, so a pgvector/text query naturally sees
   * tasks created earlier in this same batch — collapsing two dentist mentions
   * in one recording into one task.
   */
  async ingest(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    candidates: TaskCandidate[],
  ): Promise<number> {
    let cleaned = candidates
      .map((c) => ({ ...c, title: c.title.trim() }))
      .filter((c) => c.title.length > 0);
    if (cleaned.length === 0) return 0;
    if (cleaned.length > MAX_TASKS_PER_EXTRACTION) {
      this.logger.warn(
        `extraction ${extractionId} produced ${cleaned.length} candidate tasks; truncating to ${MAX_TASKS_PER_EXTRACTION}`,
      );
      cleaned = cleaned.slice(0, MAX_TASKS_PER_EXTRACTION);
    }

    // Embed all titles up front (one request). If embeddings are unconfigured or
    // the request fails, every vector stays null and we dedupe on text alone.
    const vectors = await this.embedTitles(userId, cleaned.map((c) => c.title));
    const model = (await this.embeddings.isEnabled(userId)) ? this.embeddings.id : null;

    const cited = new Set<string>();
    for (let i = 0; i < cleaned.length; i++) {
      const candidate = cleaned[i];
      const vector = vectors[i];
      const normalizedTitle = normalizeTitle(candidate.title);

      const taskId = await this.resolveTask(userId, candidate, normalizedTitle, vector, model);
      await this.upsertCitation(userId, inboxItemId, extractionId, taskId, candidate);
      cited.add(taskId);
    }
    return cited.size;
  }

  /** Find the matching open task (exact text, then semantic) or create a new one. */
  private async resolveTask(
    userId: string,
    candidate: TaskCandidate,
    normalizedTitle: string,
    vector: number[] | null,
    model: string | null,
  ): Promise<string> {
    // 1. Exact normalized-title match among open tasks — deterministic, cheap,
    //    and the whole story when embeddings are off (also catches open tasks
    //    that predate embeddings and carry no vector).
    const exact = await this.tasks.findOne({
      where: { userId, status: 'open', normalizedTitle },
    });
    if (exact) return exact.id;

    // 2. Semantic nearest open task via cosine similarity.
    if (vector) {
      const near = await this.nearestOpenTask(userId, vector);
      if (near && near.score >= this.threshold) return near.id;
    }

    // 3. No match — a genuinely new task.
    try {
      const created = await this.tasks.save(
        this.tasks.create({
          userId,
          title: candidate.title,
          normalizedTitle,
          status: 'open',
          dueDate: candidate.dueDate,
          embedding: vector,
          embeddingModel: vector ? model : null,
          embeddingDimensions: vector ? vector.length : null,
        }),
      );
      return created.id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race on the partial unique index (userId, normalizedTitle where
      // status='open') — another worker created the same open task between our
      // read and this insert. Re-read and cite the winner instead.
      const winner = await this.tasks.findOne({
        where: { userId, status: 'open', normalizedTitle },
      });
      if (!winner) throw new Error('failed to upsert task after unique violation');
      return winner.id;
    }
  }

  /** The user's OPEN task most similar to `vector`, or null. */
  private async nearestOpenTask(
    userId: string,
    vector: number[],
  ): Promise<{ id: string; score: number } | null> {
    const driver = this.tasks.manager.connection.options.type;
    if (driver === 'postgres') {
      const literal = `[${vector.join(',')}]`;
      const rows: Array<{ id: string; distance: number | string }> = await this.tasks.query(
        `SELECT id, (embedding <=> $1::vector) AS distance
         FROM tasks
         WHERE "userId" = $2 AND status = 'open' AND embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT 1`,
        [literal, userId],
      );
      if (rows.length === 0) return null;
      return { id: rows[0].id, score: 1 - Number(rows[0].distance) };
    }
    // Portable fallback for the sqlite test DB (no pgvector): in-JS cosine.
    const open = await this.tasks.find({ where: { userId, status: 'open' } });
    let best: { id: string; score: number } | null = null;
    for (const row of open) {
      if (!row.embedding || row.embedding.length !== vector.length) continue;
      const score = cosineSimilarity(vector, row.embedding);
      if (!best || score > best.score) best = { id: row.id, score };
    }
    return best;
  }

  /** One citation per (extraction, task); idempotent on re-runs/backfills. */
  private async upsertCitation(
    userId: string,
    inboxItemId: string,
    extractionId: string,
    taskId: string,
    candidate: TaskCandidate,
  ): Promise<void> {
    const existing = await this.citations.findOne({ where: { extractionId, taskId } });
    if (existing) return;
    await this.citations.save(
      this.citations.create({
        userId,
        inboxItemId,
        extractionId,
        taskId,
        quote: candidate.quote,
        startSeconds: candidate.startSeconds,
        endSeconds: candidate.endSeconds,
      }),
    );
  }

  /** Embed the candidate titles; returns a null per title when unavailable. */
  private async embedTitles(userId: string, titles: string[]): Promise<(number[] | null)[]> {
    if (titles.length === 0 || !(await this.embeddings.isEnabled(userId))) {
      return titles.map(() => null);
    }
    try {
      const { vectors } = await this.embeddings.embed(userId, titles);
      return titles.map((_, i) => (vectors[i]?.length ? vectors[i] : null));
    } catch (err) {
      this.logger.warn(
        `task dedupe embedding failed, falling back to text match: ${(err as Error).message}`,
      );
      return titles.map(() => null);
    }
  }

  // ---- Read models & mutations ----

  /**
   * The user's tasks, optionally filtered by status, newest activity first.
   * OPEN tasks with zero live citations are hidden: they are ghosts a re-run
   * with fewer tasks (or an item delete) left behind, and the recordings no
   * longer support them. The rows are kept (not deleted) so a later mention
   * can still dedupe onto them; completed/dismissed tasks stay visible either
   * way — the user explicitly actioned those.
   */
  async list(userId: string, status?: TaskStatus): Promise<TaskDto[]> {
    // Tasks are the owner's; with no owner set we don't surface any (also
    // hides stale rows if the owner was later cleared). See needsOwner gating.
    if (!(await this.selfProfile.hasOwner(userId))) return [];
    const rows = await this.tasks.find({
      where: status ? { userId, status } : { userId },
    });
    if (rows.length === 0) return [];
    const current = await this.currentCitations(rows.map((r) => r.id));
    return rows
      .map((row) => this.toDto(row, current.get(row.id) ?? []))
      .filter((dto) => dto.status !== 'open' || dto.citationCount > 0)
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /**
   * Current citation inbox-item ids per task, in ONE bulk pass — the source
   * items each (deduped) task is derived from, for external-surface sensitivity
   * gating (JJ-78). Restricted, like the read model, to each item's LATEST
   * succeeded `tasks` extraction; a task can be backed by MANY items. Task ids
   * are re-scoped to the user here so a foreign id yields no items.
   */
  async citationItemIds(userId: string, taskIds: string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (taskIds.length === 0) return map;
    const rows = await this.tasks.find({ where: { id: In(taskIds), userId } });
    const current = await this.currentCitations(rows.map((r) => r.id));
    for (const row of rows) {
      map.set(row.id, [...new Set((current.get(row.id) ?? []).map((c) => c.inboxItemId))]);
    }
    return map;
  }

  /** Change a task's lifecycle status (complete / dismiss / reopen). */
  async updateStatus(userId: string, id: string, status: TaskStatus): Promise<TaskDto> {
    const row = await this.tasks.findOne({ where: { id, userId } });
    if (!row) throw new NotFoundException('task not found');
    row.status = status;
    let saved: TaskEntity;
    try {
      saved = await this.tasks.save(row);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Reopening collided with the one-open-task-per-title guard: a fresh open
      // task with the same title was created after this one was closed.
      throw new ConflictException('an open task with the same title already exists');
    }
    const current = (await this.currentCitations([id])).get(id) ?? [];
    return this.toDto(saved, current);
  }

  /**
   * An item's tasks tab: the latest `tasks` extraction's status plus the tasks
   * it cited (with this recording's quote/segment).
   */
  async getItemTasks(item: {
    userId: string;
    extractions: ExtractedPayloadEntity[] | undefined;
  }): Promise<ItemTasksResponse> {
    if (!(await this.selfProfile.hasOwner(item.userId))) {
      return {
        status: null,
        tasks: [],
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
        needsOwner: true,
      };
    }
    const extraction = latestOfKind(item.extractions ?? [], 'tasks');
    if (!extraction) {
      return {
        status: null,
        tasks: [],
        model: null,
        error: null,
        createdAt: null,
        completedAt: null,
        needsOwner: false,
      };
    }
    const payload = parsePayload(extraction.content);
    const citations = await this.citations.find({ where: { extractionId: extraction.id } });
    const taskById = await this.tasksById(citations.map((c) => c.taskId));
    const tasks: TaskCitationDto[] = citations
      .map((c) => {
        const task = taskById.get(c.taskId);
        if (!task) return null;
        return {
          taskId: task.id,
          title: task.title,
          status: task.status,
          dueDate: task.dueDate,
          quote: c.quote,
          startSeconds: c.startSeconds,
          endSeconds: c.endSeconds,
        } satisfies TaskCitationDto;
      })
      .filter((t): t is TaskCitationDto => t !== null);
    return {
      status: extraction.status,
      tasks,
      model: payload?.model ?? null,
      error: extraction.error,
      createdAt: iso(extraction.createdAt),
      completedAt: iso(extraction.completedAt),
      needsOwner: false,
    };
  }

  private async tasksById(ids: string[]): Promise<Map<string, TaskEntity>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.tasks.find({ where: { id: In(unique) } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Citations per task, restricted to each inbox item's latest succeeded `tasks`
   * extraction — so reprocessing supersedes old citations and counts stay honest
   * (mirrors the entity-registry mention aggregation).
   */
  private async currentCitations(
    taskIds: string[],
  ): Promise<Map<string, TaskCitationEntity[]>> {
    const result = new Map<string, TaskCitationEntity[]>();
    if (taskIds.length === 0) return result;
    const rows = await this.citations.find({ where: { taskId: In(taskIds) } });
    if (rows.length === 0) return result;

    const itemIds = [...new Set(rows.map((r) => r.inboxItemId))];
    const extractionRows = await this.extractions.find({
      where: { inboxItemId: In(itemIds), kind: 'tasks', status: 'succeeded' },
    });
    const latestByItem = new Map<string, ExtractedPayloadEntity>();
    for (const row of extractionRows) {
      const current = latestByItem.get(row.inboxItemId);
      if (!current || row.createdAt > current.createdAt) latestByItem.set(row.inboxItemId, row);
    }
    const latestExtractionIds = new Set([...latestByItem.values()].map((r) => r.id));

    for (const row of rows) {
      if (!latestExtractionIds.has(row.extractionId)) continue;
      const list = result.get(row.taskId) ?? [];
      list.push(row);
      result.set(row.taskId, list);
    }
    return result;
  }

  private toDto(row: TaskEntity, citations: TaskCitationEntity[]): TaskDto {
    const itemIds = new Set(citations.map((c) => c.inboxItemId));
    const lastSeen = citations.reduce<Date | null>(
      (max, c) => (max === null || c.createdAt > max ? c.createdAt : max),
      null,
    );
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      dueDate: row.dueDate,
      citationCount: itemIds.size,
      firstSeenAt: row.createdAt.toISOString(),
      lastSeenAt: (lastSeen ?? row.updatedAt ?? row.createdAt).toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** Normalization key: lowercased, whitespace-collapsed, trailing punctuation dropped. */
export function normalizeTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,]+$/g, '')
    .trim();
}

/**
 * Whether a save failed on a unique index, across the drivers we run on:
 * Postgres surfaces SQLSTATE 23505 (unique_violation), better-sqlite3 a
 * SQLITE_CONSTRAINT* code / "UNIQUE constraint failed" message. Anything else
 * (connection loss, bad SQL, …) is a real error and must propagate. Mirrors
 * the entity-registry helper.
 */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const driverError = (err as { driverError?: unknown }).driverError ?? err;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  if (code === '23505') return true;
  if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) return true;
  const message = (driverError as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
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

function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractedPayloadEntity['kind'],
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function parsePayload(content: string | null): TaskExtractionPayload | null {
  if (!content) return null;
  try {
    const parsed = taskExtractionPayloadSchema.safeParse(JSON.parse(content));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

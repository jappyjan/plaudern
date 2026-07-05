import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import type {
  TopicDocumentCitation,
  TopicDocumentResponse,
  TopicDocumentVersionDetailDto,
  TopicDocumentVersionListResponse,
} from '@plaudern/contracts';
import { ItemTopicEntity, TopicDocumentEntity, TopicEntity } from '@plaudern/persistence';
import { analyzeCitationCoverage } from '@plaudern/citations';
import {
  TOPIC_DOCUMENT_PROVIDER,
  type TopicDocumentProvider,
} from './topic-document.provider';
import { TOPIC_DOCUMENT_QUEUE, type TopicDocumentQueue } from './topic-document.job';

/** How long to wait for a burst of classifications to settle before regenerating. */
const DEFAULT_DEBOUNCE_MS = 5_000;

/**
 * How many succeeded document versions to retain per topic (JJ-73). The
 * append-only history table (`topic_documents`) gets one new row per
 * regeneration forever, so an actively-updating topic needs a retention
 * policy or it grows unbounded. Generous on purpose — this is a "how did the
 * write-up evolve" history for a person to browse, not hot data — and always
 * covers the CURRENT version, since that's the newest of the kept set.
 */
export const DEFAULT_HISTORY_RETENTION = 10;

/**
 * Prune a topic's succeeded document history down to the most recent
 * `retention` versions (JJ-73). Called from the write path right after a
 * generation succeeds (`TopicDocumentProcessor`), so an actively-regenerating
 * topic never accumulates unbounded history.
 *
 * NEVER deletes the current (highest-succeeded) version: the cutoff is the
 * version of the `retention`-th newest succeeded row, which — when there are
 * at least `retention` succeeded rows — is always at or below the current
 * version, so only strictly-older rows are removed. When there are fewer than
 * `retention` succeeded rows yet, this is a no-op.
 *
 * Race-safe: the delete is a plain `version < cutoff` predicate re-evaluated
 * against the live table at execution time, so two overlapping prunes (or a
 * prune racing a new succeeded version being written) can only ever agree or
 * no-op — never delete a row the other call needed to keep.
 */
export async function pruneTopicDocumentHistory(
  documents: Repository<TopicDocumentEntity>,
  topicId: string,
  retention: number = DEFAULT_HISTORY_RETENTION,
): Promise<number> {
  const keep = await documents.find({
    where: { topicId, status: 'succeeded' },
    order: { version: 'DESC' },
    take: retention,
    select: { version: true },
  });
  if (keep.length < retention) return 0;
  const cutoff = keep[keep.length - 1].version;
  const res = await documents.delete({ topicId, status: 'succeeded', version: LessThan(cutoff) });
  return res.affected ?? 0;
}

/**
 * Owns living topic documents (JJ-12). WHEN a document regenerates is driven by
 * topic classification: the `TopicsProcessor` calls `onTopicsAssigned` after an
 * item lands in a topic, and this service coalesces the burst and enqueues ONE
 * regeneration per topic. It also owns the read models (current document +
 * version history), the manual regenerate action, and the helpers the startup
 * backfill uses to catch existing topics up. HOW a document is written lives in
 * `TopicDocumentProcessor`.
 *
 * The feature ships DISABLED until the generation provider is configured
 * (TOPIC_DOCS_API_KEY, falling back to the summarization key); every enqueue
 * path checks the gate first so nothing is scheduled while disabled.
 */
@Injectable()
export class TopicDocumentService implements OnModuleDestroy {
  private readonly logger = new Logger(TopicDocumentService.name);
  private readonly debounceMs: number;
  /** Per-topic coalescing timers: a burst of classifications enqueues once. */
  private readonly pending = new Map<string, { userId: string; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    config: ConfigService,
    @Inject(TOPIC_DOCUMENT_PROVIDER)
    private readonly provider: TopicDocumentProvider,
    @Inject(TOPIC_DOCUMENT_QUEUE)
    private readonly queue: TopicDocumentQueue,
    @InjectRepository(TopicEntity)
    private readonly topics: Repository<TopicEntity>,
    @InjectRepository(TopicDocumentEntity)
    private readonly documents: Repository<TopicDocumentEntity>,
    @InjectRepository(ItemTopicEntity)
    private readonly assignments: Repository<ItemTopicEntity>,
  ) {
    const raw = Number(config.get<string>('TOPIC_DOCS_DEBOUNCE_MS', String(DEFAULT_DEBOUNCE_MS)));
    this.debounceMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DEBOUNCE_MS;
  }

  /** Whether living-document generation is configured (TOPIC_DOCS_API_KEY, …). */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  onModuleDestroy(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /**
   * Signal that an item was just classified into these topics — the trigger for
   * "the document updates itself". No-op when the feature is disabled. Debounced
   * per topic so a burst (e.g. a backfill) regenerates once, not N times.
   */
  onTopicsAssigned(userId: string, topicIds: string[]): void {
    if (!this.provider.enabled) return;
    for (const topicId of new Set(topicIds)) this.scheduleRegeneration(userId, topicId);
  }

  private scheduleRegeneration(userId: string, topicId: string): void {
    const existing = this.pending.get(topicId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(topicId);
      void this.enqueueRegeneration(userId, topicId).catch((err) =>
        this.logger.error(`failed to enqueue topic document regeneration: ${(err as Error).message}`),
      );
    }, this.debounceMs);
    timer.unref?.();
    this.pending.set(topicId, { userId, timer });
  }

  /** Fire any pending debounced regenerations immediately (used by tests). */
  async flushPending(): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [topicId, { userId, timer }] of entries) {
      clearTimeout(timer);
      await this.enqueueRegeneration(userId, topicId);
    }
  }

  /**
   * Append a fresh `queued` document version for a topic and hand it to the
   * queue. Idempotent/coalescing: if a generation is already IN FLIGHT for the
   * topic — `queued` (not yet started) OR `processing` (running right now) — a
   * fresh trigger defers to it instead of stacking a second row (JJ-76). This
   * saves the redundant LLM call the old `queued`-only guard let slip whenever
   * a queued row had already flipped to `processing`.
   *
   * Deferral is only SAFE because of who covers which items:
   *  - a `queued` generation hasn't read its sources yet, so it will naturally
   *    include whatever just arrived when it runs;
   *  - a `processing` generation already read its sources, so an item that
   *    lands mid-flight is NOT in this run — the processor closes that gap with
   *    a completion-time freshness re-check that enqueues exactly one follow-up
   *    when new assignments appeared during the run (see TopicDocumentProcessor).
   *
   * Returns the (new or in-flight) document id, or null when disabled or a
   * version race was lost.
   */
  async enqueueRegeneration(userId: string, topicId: string): Promise<string | null> {
    if (!this.provider.enabled) return null;

    const inFlight = await this.documents.findOne({
      where: [
        { topicId, status: 'queued' },
        { topicId, status: 'processing' },
      ],
      order: { version: 'DESC' },
    });
    if (inFlight) return inFlight.id;

    const nextVersion = (await this.maxVersion(topicId)) + 1;
    let row: TopicDocumentEntity;
    try {
      row = await this.documents.save(
        this.documents.create({
          userId,
          topicId,
          version: nextVersion,
          status: 'queued',
          markdown: null,
          citations: null,
          sourceItemCount: 0,
          model: null,
          error: null,
        }),
      );
    } catch (err) {
      // Lost the (topicId, version) race with a concurrent enqueue; that row
      // will run and cover the same items, so skip.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    await this.queue.enqueue({ documentId: row.id, topicId, userId });
    return row.id;
  }

  /**
   * Manually (re)generate a topic's document — e.g. after a failure or to get a
   * fresh take. Requires the feature to be enabled and the topic to have at
   * least one classified item.
   */
  async regenerate(userId: string, topicId: string): Promise<string | null> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'topic documents are not configured (set TOPIC_DOCS_API_KEY, or TOPIC_DOCS_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    const topic = await this.topics.findOne({ where: { id: topicId, userId } });
    if (!topic) throw new NotFoundException('topic not found');
    const itemCount = await this.assignments.count({ where: { userId, topicId } });
    if (itemCount === 0) {
      throw new BadRequestException('topic has no classified items to document yet');
    }
    return this.enqueueRegeneration(userId, topicId);
  }

  // ---- Read models ----

  /** The topic's living document: current body + most-recent-attempt status. */
  async getDocument(userId: string, topicId: string): Promise<TopicDocumentResponse> {
    const topic = await this.topics.findOne({ where: { id: topicId, userId } });
    if (!topic) throw new NotFoundException('topic not found');

    const latest = await this.documents.findOne({
      where: { topicId },
      order: { version: 'DESC' },
    });
    const current = await this.documents.findOne({
      where: { topicId, status: 'succeeded' },
      order: { version: 'DESC' },
    });

    return {
      topicId,
      status: latest?.status ?? null,
      version: current?.version ?? null,
      markdown: current?.markdown ?? null,
      citations: current?.citations ?? [],
      confidence: current?.markdown ? coverageConfidence(current.markdown) : null,
      sourceItemCount: current?.sourceItemCount ?? null,
      model: current?.model ?? null,
      error: latest?.status === 'failed' ? latest.error : null,
      generatedAt: current ? iso(current.updatedAt) : null,
      updatedAt: latest ? iso(latest.updatedAt) : null,
      enabled: this.enabled,
    };
  }

  /** Metadata for every succeeded version of a topic's document, newest first. */
  async listVersions(userId: string, topicId: string): Promise<TopicDocumentVersionListResponse> {
    const topic = await this.topics.findOne({ where: { id: topicId, userId } });
    if (!topic) throw new NotFoundException('topic not found');
    const rows = await this.documents.find({
      where: { topicId, status: 'succeeded' },
      order: { version: 'DESC' },
    });
    return {
      topicId,
      versions: rows.map((r) => ({
        version: r.version,
        sourceItemCount: r.sourceItemCount,
        model: r.model,
        createdAt: iso(r.createdAt),
      })),
    };
  }

  /** One historical version rendered in full. */
  async getVersion(
    userId: string,
    topicId: string,
    version: number,
  ): Promise<TopicDocumentVersionDetailDto> {
    const topic = await this.topics.findOne({ where: { id: topicId, userId } });
    if (!topic) throw new NotFoundException('topic not found');
    const row = await this.documents.findOne({
      where: { topicId, version, status: 'succeeded' },
    });
    if (!row || row.markdown === null) throw new NotFoundException('document version not found');
    return {
      topicId,
      version: row.version,
      markdown: row.markdown,
      citations: (row.citations ?? []) as TopicDocumentCitation[],
      confidence: coverageConfidence(row.markdown),
      sourceItemCount: row.sourceItemCount,
      model: row.model,
      createdAt: iso(row.createdAt),
    };
  }

  // ---- Backfill support ----

  /**
   * Every existing topic (with classified items) whose living document is
   * missing or stale — the work list the startup backfill enqueues. A topic is
   * stale when an item was classified into it after its latest succeeded
   * document was created. Archived and deleted topics are skipped.
   */
  async topicsNeedingRegeneration(): Promise<{ userId: string; topicId: string }[]> {
    const rows = await this.assignments
      .createQueryBuilder('it')
      .select('it.topicId', 'topicId')
      .addSelect('it.userId', 'userId')
      .addSelect('MAX(it.createdAt)', 'lastItemAt')
      .groupBy('it.topicId')
      .addGroupBy('it.userId')
      .getRawMany<{ topicId: string; userId: string; lastItemAt: string | Date }>();

    const result: { userId: string; topicId: string }[] = [];
    for (const row of rows) {
      const topic = await this.topics.findOne({
        where: { id: row.topicId, userId: row.userId, archived: false },
      });
      if (!topic) continue;
      const doc = await this.documents.findOne({
        where: { topicId: row.topicId, status: 'succeeded' },
        order: { version: 'DESC' },
      });
      if (!doc) {
        result.push({ userId: row.userId, topicId: row.topicId });
        continue;
      }
      if (time(row.lastItemAt) > time(doc.createdAt)) {
        result.push({ userId: row.userId, topicId: row.topicId });
      }
    }
    return result;
  }

  /**
   * Remove document rows for topics that no longer exist (a topic delete prunes
   * its `item_topics`; this reaps the matching documents). Returns the number
   * deleted. Called by the startup sweep so orphans never accumulate.
   */
  async pruneOrphans(): Promise<number> {
    const docTopicRows = await this.documents
      .createQueryBuilder('d')
      .select('DISTINCT d.topicId', 'topicId')
      .getRawMany<{ topicId: string }>();
    let deleted = 0;
    for (const { topicId } of docTopicRows) {
      const exists = await this.topics.count({ where: { id: topicId } });
      if (exists === 0) {
        const res = await this.documents.delete({ topicId });
        deleted += res.affected ?? 0;
      }
    }
    return deleted;
  }

  private async maxVersion(topicId: string): Promise<number> {
    const row = await this.documents
      .createQueryBuilder('d')
      .select('MAX(d.version)', 'max')
      .where('d.topicId = :topicId', { topicId })
      .getRawOne<{ max: number | string | null }>();
    const max = Number(row?.max ?? 0);
    return Number.isFinite(max) ? max : 0;
  }
}

/**
 * Read-time citation-coverage confidence (JJ-20). A living document is a cited
 * write-up; if too few of its clauses carry a citation the reader should see
 * "I think — check the sources" rather than trust it as settled memory. Uses
 * the shared clause-level analyzer with the softer coverage-ratio threshold
 * (not chat's strict any-uncited rule). Purely derived — no persisted field, no
 * migration.
 */
function coverageConfidence(markdown: string): 'high' | 'low' {
  return analyzeCitationCoverage(markdown).confidence;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function time(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

/**
 * Whether a save failed on a unique index, across the drivers we run on
 * (Postgres 23505, better-sqlite3 SQLITE_CONSTRAINT*). Mirrors the same helper
 * in the topic-proposals persistence.
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

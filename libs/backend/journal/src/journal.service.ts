import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type {
  JournalDocumentResponse,
  JournalPeriodListResponse,
  JournalPeriodType,
  JournalVersionDetailDto,
  JournalVersionListResponse,
} from '@plaudern/contracts';
import {
  CalendarEventEntity,
  InboxItemEntity,
  JournalDocumentEntity,
} from '@plaudern/persistence';
import { analyzeCitationCoverage } from '@plaudern/citations';
import { JOURNAL_PROVIDER, type JournalProvider } from './journal.provider';
import { JOURNAL_QUEUE, type JournalQueue } from './journal.job';
import { previewOf } from './journal-context';
import {
  ROLLUP_TYPES,
  childTypeOf,
  isValidPeriodKey,
  periodHasEnded,
  rollupKeyOfChild,
} from './journal-period';

/** One period the sweep should (re)compose. */
export interface JournalTarget {
  userId: string;
  periodType: JournalPeriodType;
  periodKey: string;
}

/**
 * Owns auto-journal entries (JJ-17): the read models, the enqueue/regenerate
 * actions, and the candidate detection the evening scheduler uses. HOW an entry
 * is composed (gathering the day's signals or a period's dailies and calling the
 * LLM) lives in `JournalProcessor`.
 *
 * Ships DISABLED until the provider is configured (JOURNAL_API_KEY, falling back
 * to the summarization key). Every enqueue path checks the gate first, so
 * nothing is scheduled while disabled. Entries are append-only versioned: a
 * regeneration inserts a new version and reads pick the highest succeeded one,
 * so re-running never clobbers a good entry.
 */
@Injectable()
export class JournalService {
  private readonly logger = new Logger(JournalService.name);

  constructor(
    @Inject(JOURNAL_PROVIDER)
    private readonly provider: JournalProvider,
    @Inject(JOURNAL_QUEUE)
    private readonly queue: JournalQueue,
    @InjectRepository(JournalDocumentEntity)
    private readonly documents: Repository<JournalDocumentEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    @InjectRepository(CalendarEventEntity)
    private readonly events: Repository<CalendarEventEntity>,
  ) {}

  /** Whether journal composition is configured (JOURNAL_API_KEY, …). */
  get enabled(): boolean {
    return this.provider.enabled;
  }

  // ---- Write path ----

  /**
   * Append a fresh `queued` version for a period and hand it to the queue.
   * Coalescing: if a generation is already queued OR in-flight (`processing`)
   * for the period, do not stack a second row — a hourly sweep that fires while
   * a worker is still running must NOT spawn a duplicate concurrent generation.
   * Any signal that landed during that run is re-derived as stale on a later
   * sweep (staleness is measured against the enqueue/`createdAt` time, which
   * precedes the worker's source snapshot), so nothing is dropped. Returns the
   * (new or pending) document id, or null when disabled or a version race was
   * lost.
   */
  async enqueueGeneration(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<string | null> {
    if (!this.provider.enabled) return null;

    const inFlight = await this.documents.findOne({
      where: { userId, periodType, periodKey, status: In(['queued', 'processing']) },
      order: { version: 'DESC' },
    });
    if (inFlight) return inFlight.id;

    const nextVersion = (await this.maxVersion(userId, periodType, periodKey)) + 1;
    let row: JournalDocumentEntity;
    try {
      row = await this.documents.save(
        this.documents.create({
          userId,
          periodType,
          periodKey,
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
      // Lost the (period, version) race with a concurrent enqueue; that row
      // will run and cover the same signals, so skip.
      if (isUniqueViolation(err)) return null;
      throw err;
    }
    await this.queue.enqueue({ documentId: row.id, userId, periodType, periodKey });
    return row.id;
  }

  /**
   * Manually (re)compose a period. Requires the feature to be enabled, a valid
   * key, and at least one thing to compose from (a signal for a day, a daily
   * entry for a rollup).
   */
  async regenerate(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<string | null> {
    if (!this.provider.enabled) {
      throw new BadRequestException(
        'auto-journal is not configured (set JOURNAL_API_KEY, or JOURNAL_ENABLED=true for keyless local endpoints such as Ollama)',
      );
    }
    if (!isValidPeriodKey(periodType, periodKey)) {
      throw new BadRequestException('invalid period key');
    }
    const hasSource =
      periodType === 'day'
        ? await this.dayHasSignal(userId, periodKey)
        : await this.rollupHasChildren(userId, periodType, periodKey);
    if (!hasSource) {
      throw new BadRequestException(
        periodType === 'day'
          ? 'no signals recorded for this day to compose'
          : 'no daily entries in this period to compose from yet',
      );
    }
    return this.enqueueGeneration(userId, periodType, periodKey);
  }

  // ---- Read models ----

  /** The current entry for a period: latest succeeded body + latest-attempt status. */
  async getJournal(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<JournalDocumentResponse> {
    if (!isValidPeriodKey(periodType, periodKey)) {
      throw new BadRequestException('invalid period key');
    }
    const latest = await this.documents.findOne({
      where: { userId, periodType, periodKey },
      order: { version: 'DESC' },
    });
    const current = await this.documents.findOne({
      where: { userId, periodType, periodKey, status: 'succeeded' },
      order: { version: 'DESC' },
    });
    return {
      periodType,
      periodKey,
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

  /** Every composed period of a granularity for the user, newest period first. */
  async listPeriods(
    userId: string,
    periodType: JournalPeriodType,
  ): Promise<JournalPeriodListResponse> {
    const rows = await this.documents.find({
      where: { userId, periodType, status: 'succeeded' },
      order: { periodKey: 'DESC', version: 'DESC' },
    });
    // Keep only the highest succeeded version per periodKey (rows are already
    // ordered version-desc within a key).
    const seen = new Set<string>();
    const periods = [];
    for (const r of rows) {
      if (seen.has(r.periodKey)) continue;
      seen.add(r.periodKey);
      periods.push({
        periodType,
        periodKey: r.periodKey,
        version: r.version,
        sourceItemCount: r.sourceItemCount,
        preview: previewOf(r.markdown),
        generatedAt: iso(r.updatedAt),
      });
    }
    return { periodType, periods, enabled: this.enabled };
  }

  /** Metadata for every succeeded version of a period's entry, newest first. */
  async listVersions(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<JournalVersionListResponse> {
    const rows = await this.documents.find({
      where: { userId, periodType, periodKey, status: 'succeeded' },
      order: { version: 'DESC' },
    });
    return {
      periodType,
      periodKey,
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
    periodType: JournalPeriodType,
    periodKey: string,
    version: number,
  ): Promise<JournalVersionDetailDto> {
    const row = await this.documents.findOne({
      where: { userId, periodType, periodKey, version, status: 'succeeded' },
    });
    if (!row || row.markdown === null) throw new BadRequestException('entry version not found');
    return {
      periodType,
      periodKey,
      version: row.version,
      markdown: row.markdown,
      citations: row.citations ?? [],
      confidence: coverageConfidence(row.markdown),
      sourceItemCount: row.sourceItemCount,
      model: row.model,
      createdAt: iso(row.createdAt),
    };
  }

  // ---- Sweep candidate detection (used by the evening scheduler) ----

  /**
   * Days that have signals whose entry is missing or stale — a day is stale
   * when a signal was ingested/updated after its latest succeeded entry was
   * generated (this also catches late-arriving recordings dated to a past day).
   * Merged-away recordings are excluded (the merged item covers their range).
   */
  async daysNeedingComposition(): Promise<JournalTarget[]> {
    const freshness = new Map<string, number>(); // `${userId}|${dayKey}` -> last activity ms

    const itemRows = await this.items
      .createQueryBuilder('item')
      .select('item.userId', 'userId')
      .addSelect('substr(item.occurredAt, 1, 10)', 'dayKey')
      .addSelect('MAX(item.ingestedAt)', 'lastAt')
      .where((qb) => {
        const sub = qb
          .subQuery()
          .select('1')
          .from('recording_merges', 'rm')
          .where('rm.sourceItemId = item.id')
          .getQuery();
        return `NOT EXISTS ${sub}`;
      })
      .groupBy('item.userId')
      .addGroupBy('substr(item.occurredAt, 1, 10)')
      .getRawMany<{ userId: string; dayKey: string; lastAt: string | Date }>();
    for (const r of itemRows) bump(freshness, r.userId, r.dayKey, r.lastAt);

    const eventRows = await this.events
      .createQueryBuilder('ev')
      .select('ev.userId', 'userId')
      .addSelect('substr(ev.startAt, 1, 10)', 'dayKey')
      .addSelect('MAX(ev.updatedAt)', 'lastAt')
      .groupBy('ev.userId')
      .addGroupBy('substr(ev.startAt, 1, 10)')
      .getRawMany<{ userId: string; dayKey: string; lastAt: string | Date }>();
    for (const r of eventRows) bump(freshness, r.userId, r.dayKey, r.lastAt);

    const targets: JournalTarget[] = [];
    for (const [key, lastAt] of freshness) {
      const [userId, dayKey] = key.split('|');
      if (!dayKey) continue;
      const doc = await this.latestSucceeded(userId, 'day', dayKey);
      if (!doc || time(doc.createdAt) < lastAt) {
        targets.push({ userId, periodType: 'day', periodKey: dayKey });
      }
    }
    return targets;
  }

  /**
   * Ended weeks/months/years whose rollup is missing or stale (a child entry was
   * composed after the rollup). Composition is HIERARCHICAL: weeks and months
   * roll up from the DAILY entries, years roll up from the MONTHLY entries — so
   * a candidate only appears once its children exist, and staleness propagates
   * upward as a regenerated child gets a newer `createdAt`. Only ended periods
   * are swept — reviews are retrospective; a manual regenerate can still compose
   * the current period on demand.
   */
  async rollupsNeedingComposition(now: Date = new Date()): Promise<JournalTarget[]> {
    // `${userId}|${rollupType}|${rollupKey}` -> newest child createdAt (ms)
    const childFreshness = new Map<string, number>();
    for (const rollupType of ROLLUP_TYPES) {
      const childType = childTypeOf(rollupType);
      const children = await this.documents.find({
        where: { periodType: childType, status: 'succeeded' },
        select: { userId: true, periodKey: true, createdAt: true },
      });
      for (const c of children) {
        const rollupKey = rollupKeyOfChild(rollupType, c.periodKey);
        const k = `${c.userId}|${rollupType}|${rollupKey}`;
        childFreshness.set(k, Math.max(childFreshness.get(k) ?? 0, time(c.createdAt)));
      }
    }

    const targets: JournalTarget[] = [];
    for (const [key, childAt] of childFreshness) {
      const [userId, type, rollupKey] = key.split('|');
      const periodType = type as Exclude<JournalPeriodType, 'day'>;
      if (!periodHasEnded(periodType, rollupKey, now)) continue;
      const doc = await this.latestSucceeded(userId, periodType, rollupKey);
      if (!doc || time(doc.createdAt) < childAt) {
        targets.push({ userId, periodType, periodKey: rollupKey });
      }
    }
    return targets;
  }

  // ---- Helpers ----

  private async dayHasSignal(userId: string, dayKey: string): Promise<boolean> {
    const items = await this.items
      .createQueryBuilder('item')
      .where('item.userId = :userId', { userId })
      .andWhere('substr(item.occurredAt, 1, 10) = :dayKey', { dayKey })
      .getCount();
    if (items > 0) return true;
    const events = await this.events
      .createQueryBuilder('ev')
      .where('ev.userId = :userId', { userId })
      .andWhere('substr(ev.startAt, 1, 10) = :dayKey', { dayKey })
      .getCount();
    return events > 0;
  }

  private async rollupHasChildren(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<boolean> {
    const rollupType = periodType as Exclude<JournalPeriodType, 'day'>;
    const children = await this.documents.find({
      where: { userId, periodType: childTypeOf(rollupType), status: 'succeeded' },
      select: { periodKey: true },
    });
    return children.some((c) => rollupKeyOfChild(rollupType, c.periodKey) === periodKey);
  }

  private latestSucceeded(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<JournalDocumentEntity | null> {
    return this.documents.findOne({
      where: { userId, periodType, periodKey, status: 'succeeded' },
      order: { version: 'DESC' },
    });
  }

  private async maxVersion(
    userId: string,
    periodType: JournalPeriodType,
    periodKey: string,
  ): Promise<number> {
    const row = await this.documents
      .createQueryBuilder('d')
      .select('MAX(d.version)', 'max')
      .where('d.userId = :userId', { userId })
      .andWhere('d.periodType = :periodType', { periodType })
      .andWhere('d.periodKey = :periodKey', { periodKey })
      .getRawOne<{ max: number | string | null }>();
    const max = Number(row?.max ?? 0);
    return Number.isFinite(max) ? max : 0;
  }
}

function bump(map: Map<string, number>, userId: string, dayKey: string, at: string | Date): void {
  if (!dayKey) return;
  const key = `${userId}|${dayKey}`;
  map.set(key, Math.max(map.get(key) ?? 0, time(at)));
}

/**
 * Read-time citation-coverage confidence (JJ-20). A journal entry is a cited
 * narrative; if too few of its clauses carry a citation the reader should see
 * "I think — check the sources" rather than trust it as settled memory. Uses
 * the shared clause-level analyzer with the softer coverage-ratio threshold
 * (not chat's strict any-uncited rule) so normally-cited prose isn't flagged.
 * Purely derived — no persisted field, no migration.
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
 * in the topic-document persistence.
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

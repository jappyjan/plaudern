import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  isExternalLlmKind,
  type ExtractionBackfillRequest,
  type ExtractionKind,
  type ExtractionRunDto,
} from '@plaudern/contracts';
import type { Extractor } from '@plaudern/inbox';
import {
  ExtractionRunEntity,
  InboxItemEntity,
  RecordingMergeEntity,
} from '@plaudern/persistence';
import { SensitivityRoutingService } from '@plaudern/sensitivity';
import { ExtractorGraph } from './extractor-graph';
import { evaluateReadiness, isActive, latestOfKind } from './readiness';

/** Items are loaded (with relations) in slices of this size. */
const BATCH_SIZE = 25;

/**
 * A `running` startup run whose heartbeat (updatedAt, touched by the run
 * loop's per-batch counter update) is older than this is considered stale:
 * its process died mid-sweep (SIGKILL / OOM / redeploy) — a live sweep
 * refreshes the row at least once per batch. Stale runs are marked failed and
 * superseded by the next boot's sweep; without this, one crashed sweep would
 * block its kind on every future boot. Generous enough that a slow batch
 * (e.g. inline-queue local dev, where enqueue processes synchronously) is not
 * mistaken for a crash.
 */
export const STARTUP_RUN_STALE_MS = 15 * 60 * 1000;

/**
 * Backfill runs: "re-run `kind@version` over past items" (VISION §8). A run
 * walks the user's items and, for every item where the kind applies and its
 * dependencies are satisfied, appends a fresh extraction row through the
 * extractor's normal enqueue path — append-only, the existing rows are never
 * touched. Without `force`, items whose latest succeeded row already carries
 * the current version are skipped, which is the "the extractor improved,
 * catch old items up" workflow.
 *
 * Runs execute in-process in the background; the run row carries live
 * counters so clients can poll progress.
 */
@Injectable()
export class ExtractionRunsService {
  private readonly logger = new Logger(ExtractionRunsService.name);

  constructor(
    private readonly graph: ExtractorGraph,
    @InjectRepository(ExtractionRunEntity)
    private readonly runs: Repository<ExtractionRunEntity>,
    @InjectRepository(InboxItemEntity)
    private readonly items: Repository<InboxItemEntity>,
    private readonly routing: SensitivityRoutingService,
  ) {}

  async startBackfill(userId: string, req: ExtractionBackfillRequest): Promise<ExtractionRunDto> {
    const extractor = this.graph.get(req.kind);
    if (!extractor) {
      throw new BadRequestException(`no extractor registered for kind '${req.kind}'`);
    }
    if (!extractor.enabled()) {
      throw new BadRequestException(`extractor '${req.kind}' is not configured on this server`);
    }
    if (req.occurredFrom && req.occurredTo && req.occurredFrom > req.occurredTo) {
      throw new BadRequestException('occurredFrom must not be after occurredTo');
    }

    const run = await this.runs.save(
      this.runs.create({
        userId,
        kind: req.kind,
        trigger: 'manual',
        targetVersion: extractor.version,
        force: req.force,
        occurredFrom: req.occurredFrom ?? null,
        occurredTo: req.occurredTo ?? null,
        status: 'running',
      }),
    );

    // Fire-and-forget: the endpoint returns immediately; clients poll the run.
    void this.execute(run.id).catch((err) => {
      this.logger.error(`backfill run ${run.id} crashed: ${(err as Error).message}`);
    });

    return toRunDto(run);
  }

  /**
   * Start a system-wide `startup` backfill for one kind: the automatic
   * "catch missing/failed steps up on every boot" sweep (see
   * StartupBackfillService). Unlike {@link startBackfill} the run is NOT
   * scoped to a user (userId = null) — it walks every user's items, enqueuing
   * a fresh attempt wherever the step is missing or the latest attempt failed
   * / predates the current extractor version.
   *
   * Idempotency: if a `startup` run for this kind is still `running` AND its
   * heartbeat is fresh (another replica's live sweep), no new run is started —
   * that run is returned instead. A `running` run whose heartbeat is older
   * than {@link STARTUP_RUN_STALE_MS} is a leftover of a process that died
   * mid-sweep; it is marked failed and a fresh run is started, so a crash or
   * hard redeploy never wedges the kind. Returns null when the kind is unknown
   * or its extractor is disabled on this server.
   */
  async startStartupBackfill(kind: ExtractionKind): Promise<ExtractionRunDto | null> {
    const extractor = this.graph.get(kind);
    if (!extractor || !extractor.enabled()) return null;

    // Skip-if-running with a staleness lease: a live sweep (this or another
    // replica) heartbeats updatedAt per batch; only such a run blocks a new
    // sweep. Anything older is a crash leftover and gets superseded.
    const openRuns = await this.runs.find({
      where: { kind, trigger: 'startup', status: 'running' },
      order: { createdAt: 'DESC' },
    });
    const now = Date.now();
    const live = openRuns.find(
      (run) => now - new Date(run.updatedAt).getTime() < STARTUP_RUN_STALE_MS,
    );
    if (live) {
      this.logger.log(
        `startup backfill '${kind}': a previous run (${live.id}) is still running — skipping`,
      );
      return toRunDto(live);
    }
    for (const stale of openRuns) {
      // Guard on status so we never clobber a run that finished in between.
      await this.runs.update(
        { id: stale.id, status: 'running' },
        {
          status: 'failed',
          error: 'stale: no heartbeat — the process died mid-sweep; superseded by a reboot sweep',
          completedAt: new Date().toISOString(),
        },
      );
      this.logger.warn(
        `startup backfill '${kind}': marked stale run ${stale.id} as failed (superseded by reboot)`,
      );
    }

    const run = await this.runs.save(
      this.runs.create({
        userId: null,
        kind,
        trigger: 'startup',
        targetVersion: extractor.version,
        force: false,
        occurredFrom: null,
        occurredTo: null,
        status: 'running',
      }),
    );

    void this.execute(run.id).catch((err) => {
      this.logger.error(`startup backfill run ${run.id} crashed: ${(err as Error).message}`);
    });

    return toRunDto(run);
  }

  async getRun(userId: string, id: string): Promise<ExtractionRunDto> {
    // A user sees their own runs plus the system-wide startup sweeps.
    const run = await this.runs.findOne({
      where: [
        { id, userId },
        { id, userId: IsNull() },
      ],
    });
    if (!run) throw new NotFoundException('extraction run not found');
    return toRunDto(run);
  }

  /**
   * The user's own runs; system-wide startup sweeps (userId null) only when
   * `includeSystem` is set — otherwise 7 kinds × a few reboots would crowd the
   * take-50 window and push the user's own manual runs out of the listing.
   */
  async listRuns(userId: string, includeSystem = false): Promise<ExtractionRunDto[]> {
    const rows = await this.runs.find({
      where: includeSystem ? [{ userId }, { userId: IsNull() }] : { userId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    return rows.map(toRunDto);
  }

  /** Walk the items in batches, enqueueing where due; keeps counters live. */
  private async execute(runId: string): Promise<void> {
    const run = await this.runs.findOneOrFail({ where: { id: runId } });
    const extractor = this.graph.get(run.kind);
    if (!extractor) {
      await this.finish(run, 'failed', `no extractor registered for kind '${run.kind}'`);
      return;
    }

    try {
      let cursor: string | null = null;
      for (;;) {
        const batch: InboxItemEntity[] = await this.nextBatch(run, cursor);
        if (batch.length === 0) break;
        cursor = batch[batch.length - 1].id;

        for (const item of batch) {
          run.itemsMatched += 1;
          if (this.shouldEnqueue(extractor, item, run)) {
            // Local-only routing guard (JJ-21): a backfill must not send
            // sensitive content externally either. Hold / skip the same way the
            // event pipeline does.
            if (isExternalLlmKind(run.kind)) {
              const decision = await this.routing.decide(item.id, run.kind);
              if (decision === 'hold') {
                await this.routing.markHeld(item.id);
                run.itemsSkipped += 1;
                continue;
              }
              if (decision === 'wait') {
                run.itemsSkipped += 1;
                continue;
              }
              await this.routing.clearHeld(item.id);
            }
            try {
              await extractor.enqueue(item);
              run.itemsQueued += 1;
            } catch (err) {
              run.itemsFailed += 1;
              this.logger.warn(
                `backfill ${run.id}: enqueue '${run.kind}' failed for item ${item.id}: ${(err as Error).message}`,
              );
            }
          } else {
            run.itemsSkipped += 1;
          }
        }
        await this.runs.update(
          { id: run.id },
          {
            itemsMatched: run.itemsMatched,
            itemsQueued: run.itemsQueued,
            itemsSkipped: run.itemsSkipped,
            itemsFailed: run.itemsFailed,
          },
        );
      }
      await this.finish(run, 'completed', null);
    } catch (err) {
      await this.finish(run, 'failed', (err as Error).message);
    }
  }

  /**
   * Enqueue iff the kind applies, its dependencies are satisfied, no attempt
   * is currently in flight, and (unless forced) the latest succeeded row is
   * still below the target version.
   */
  private shouldEnqueue(
    extractor: Extractor,
    item: InboxItemEntity,
    run: ExtractionRunEntity,
  ): boolean {
    if (!extractor.enabled() || !extractor.appliesTo(item)) return false;
    if (!evaluateReadiness(extractor, item, this.graph).ready) return false;

    const extractions = item.extractions ?? [];
    const latest = latestOfKind(extractions, run.kind);
    if (latest && isActive(latest.status)) return false; // already in flight

    if (!run.force) {
      const latestSucceeded = extractions
        .filter((e) => e.kind === run.kind && e.status === 'succeeded')
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
      if (latestSucceeded && (latestSucceeded.version ?? 1) >= run.targetVersion) {
        return false; // already at the target version
      }
    }
    return true;
  }

  /**
   * Keyset batch over the user's items (stable id order), applying the
   * occurredAt window and hiding items merged into another recording — they
   * are invisible in the inbox and would waste provider calls.
   */
  private async nextBatch(
    run: ExtractionRunEntity,
    afterId: string | null,
  ): Promise<InboxItemEntity[]> {
    const qb = this.items
      .createQueryBuilder('item')
      .leftJoinAndSelect('item.source', 'source')
      .leftJoinAndSelect('item.extractions', 'extractions')
      // Manual runs are user-scoped; the system-wide startup sweep (userId
      // null) walks every user's items.
      .where(run.userId ? 'item.userId = :userId' : '1 = 1', { userId: run.userId })
      .andWhere((sub) => {
        const hidden = sub
          .subQuery()
          .select('1')
          .from(RecordingMergeEntity, 'rm')
          .where('rm.sourceItemId = item.id')
          .getQuery();
        return `NOT EXISTS ${hidden}`;
      })
      .orderBy('item.id', 'ASC')
      .take(BATCH_SIZE);
    if (afterId) qb.andWhere('item.id > :afterId', { afterId });
    // occurredAt is a normalized ISO-8601 instant, so string comparison is
    // chronological on both Postgres and sqlite.
    if (run.occurredFrom) qb.andWhere('item.occurredAt >= :from', { from: run.occurredFrom });
    if (run.occurredTo) qb.andWhere('item.occurredAt <= :to', { to: run.occurredTo });
    return qb.getMany();
  }

  private async finish(
    run: ExtractionRunEntity,
    status: 'completed' | 'failed',
    error: string | null,
  ): Promise<void> {
    await this.runs.update(
      { id: run.id },
      {
        status,
        error,
        itemsMatched: run.itemsMatched,
        itemsQueued: run.itemsQueued,
        itemsSkipped: run.itemsSkipped,
        itemsFailed: run.itemsFailed,
        completedAt: new Date().toISOString(),
      },
    );
  }
}

function toRunDto(run: ExtractionRunEntity): ExtractionRunDto {
  return {
    id: run.id,
    kind: run.kind,
    trigger: run.trigger,
    targetVersion: run.targetVersion,
    force: run.force,
    occurredFrom: run.occurredFrom,
    occurredTo: run.occurredTo,
    status: run.status,
    itemsMatched: run.itemsMatched,
    itemsQueued: run.itemsQueued,
    itemsSkipped: run.itemsSkipped,
    itemsFailed: run.itemsFailed,
    error: run.error,
    createdAt: run.createdAt instanceof Date ? run.createdAt.toISOString() : run.createdAt,
    completedAt: run.completedAt,
  };
}

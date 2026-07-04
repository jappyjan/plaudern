import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ExtractionBackfillRequest, ExtractionRunDto } from '@plaudern/contracts';
import type { Extractor } from '@plaudern/inbox';
import {
  ExtractionRunEntity,
  InboxItemEntity,
  RecordingMergeEntity,
} from '@plaudern/persistence';
import { ExtractorGraph } from './extractor-graph';
import { evaluateReadiness, isActive, latestOfKind } from './readiness';

/** Items are loaded (with relations) in slices of this size. */
const BATCH_SIZE = 25;

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

  async getRun(userId: string, id: string): Promise<ExtractionRunDto> {
    const run = await this.runs.findOne({ where: { id, userId } });
    if (!run) throw new NotFoundException('extraction run not found');
    return toRunDto(run);
  }

  async listRuns(userId: string): Promise<ExtractionRunDto[]> {
    const rows = await this.runs.find({
      where: { userId },
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
      .where('item.userId = :userId', { userId: run.userId })
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

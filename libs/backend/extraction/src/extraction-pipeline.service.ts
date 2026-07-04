import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { InboxEventsService, InboxService, type Extractor } from '@plaudern/inbox';
import type { InboxItemEntity } from '@plaudern/persistence';
import { ExtractorGraph } from './extractor-graph';
import { evaluateReadiness, isGenerationCovered } from './readiness';

/**
 * Drives the extraction DAG:
 *
 * - `processCommitted` is invoked by ingestion when a source is committed (or
 *   reprocessed) and enqueues every applicable ROOT extractor — always a
 *   fresh, append-only attempt, exactly like the old hardcoded
 *   transcription+diarization calls.
 * - Dependent extractors are event-driven: whenever any extraction reaches a
 *   terminal state, every extractor depending on that kind is re-evaluated
 *   through the generic readiness gate (see readiness.ts) and enqueued once
 *   its dependencies have settled — this generalizes the old bespoke
 *   SummarizationTrigger to arbitrary extraction kinds.
 *
 * Failures never propagate: a broken downstream extractor must not break the
 * pipeline (or the request that triggered it).
 */
@Injectable()
export class ExtractionPipelineService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtractionPipelineService.name);
  private subscription?: Subscription;
  /** In-process guard so two near-simultaneous completions don't double-enqueue. */
  private readonly evaluating = new Set<string>();

  constructor(
    private readonly graph: ExtractorGraph,
    private readonly inbox: InboxService,
    private readonly events: InboxEventsService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.events.allEvents().subscribe(({ event }) => {
      if (event.type !== 'extraction.updated') return;
      if (event.status !== 'succeeded' && event.status !== 'failed') return;
      for (const dependent of this.graph.dependentsOf(event.kind)) {
        // Fire-and-forget: a downstream failure must never break the pipeline.
        void this.maybeRun(event.itemId, dependent).catch((err) => {
          this.logger.warn(
            `evaluating '${dependent.kind}' for ${event.itemId} failed: ${(err as Error).message}`,
          );
        });
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Kick off the DAG for a freshly committed (or reprocessed) item: enqueue
   * every applicable root extractor. Downstream extractors follow via events
   * as their dependencies settle.
   */
  async processCommitted(item: InboxItemEntity): Promise<void> {
    for (const extractor of this.graph.roots()) {
      if (!extractor.enabled() || !extractor.appliesTo(item)) continue;
      await extractor.enqueue(item);
    }
  }

  /**
   * Enqueue `extractor` for the item iff it applies, its dependencies are
   * ready, and the current dependency generation isn't already covered by an
   * existing (succeeded or in-flight) row — the append-only equivalent of
   * "run each step exactly once per input generation".
   */
  private async maybeRun(inboxItemId: string, extractor: Extractor): Promise<void> {
    if (!extractor.enabled()) return;
    const key = `${inboxItemId}:${extractor.kind}`;
    if (this.evaluating.has(key)) return;
    this.evaluating.add(key);
    try {
      const item = await this.inbox.getItemById(inboxItemId);
      if (!item || !extractor.appliesTo(item)) return;

      const readiness = evaluateReadiness(extractor, item, this.graph);
      if (!readiness.ready) return;
      if (isGenerationCovered(item.extractions ?? [], extractor.kind, readiness.generationTs)) {
        return; // this generation is already extracted or in progress
      }
      await extractor.enqueue(item);
    } finally {
      this.evaluating.delete(key);
    }
  }
}

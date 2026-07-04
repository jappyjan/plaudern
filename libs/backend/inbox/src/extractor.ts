import type { ExtractionKind, ExtractorDependencyRequirement } from '@plaudern/contracts';
import type { InboxItemEntity } from '@plaudern/persistence';

/**
 * How an extractor depends on an upstream extraction kind.
 *
 * - `succeeded`: the dependency must apply to the item and have succeeded
 *   before this extractor may run; if the dependency does not apply to an
 *   item, this extractor does not apply either (a summary is impossible
 *   without a transcript).
 * - `settled`: if the dependency applies to the item, wait until its latest
 *   attempt reaches a terminal state, but tolerate failure; if it does not
 *   apply, proceed without it (a summary survives a failed diarization — it
 *   just loses speaker attribution).
 */
export interface ExtractorDependency {
  kind: ExtractionKind;
  requires: ExtractorDependencyRequirement;
}

/**
 * One node of the declarative extraction-pipeline DAG (VISION §8). Each
 * extraction kind (transcription, diarization, summary, and every future
 * kind: commitments, entities, OCR, …) is described by one Extractor and
 * registered with the graph in `@plaudern/extraction`; the pipeline decides
 * WHEN to run it, the extractor owns HOW (its queue, provider, and result
 * rows stay in its own module).
 *
 * The interface lives in `@plaudern/inbox` — which every extraction module
 * already depends on — so implementations and the aggregating pipeline lib
 * can share it without a package cycle.
 *
 * Invariant: `enqueue` must only APPEND extraction rows (via
 * `InboxService.addExtraction`, recording `version`); it must never mutate
 * source payloads or existing extractions.
 */
export interface Extractor {
  readonly kind: ExtractionKind;

  /**
   * Version of this extractor's output. Bump it when the output meaningfully
   * improves (better model, better prompt); backfill runs use it to find
   * items still carrying an older version.
   */
  readonly version: number;

  /** Upstream kinds this extractor waits for. Empty = root (runs on commit). */
  readonly dependsOn: ExtractorDependency[];

  /** Whether the extractor's provider is configured on this server. */
  enabled(): boolean;

  /**
   * Whether this extractor is relevant for the item at all (e.g. transcription
   * applies only to committed audio). Independent of dependency readiness.
   */
  appliesTo(item: InboxItemEntity): boolean;

  /**
   * Append a fresh `queued` extraction row and hand the job to this
   * extractor's queue. Returns the new extraction id (or null if the
   * extractor declined, e.g. disabled between check and call).
   */
  enqueue(item: InboxItemEntity): Promise<string | null>;
}

/** DI token under which the extraction lib collects all registered extractors. */
export const EXTRACTORS = Symbol('EXTRACTORS');

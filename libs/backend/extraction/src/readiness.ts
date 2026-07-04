import type { ExtractionKind, ExtractionStatus } from '@plaudern/contracts';
import type { Extractor } from '@plaudern/inbox';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import type { ExtractorGraph } from './extractor-graph';

const ACTIVE_STATUSES: ExtractionStatus[] = ['queued', 'processing'];

export type Readiness =
  | {
      ready: true;
      /**
       * Timestamp of the newest dependency attempt this run would consume —
       * the "generation". A kind whose latest row is at/after this generation
       * (and succeeded or in flight) is already up to date.
       */
      generationTs: number;
    }
  | { ready: false; reason: string };

/**
 * Generic readiness gate for one extractor on one item, generalizing what the
 * old SummarizationTrigger hand-coded for summary←(transcription,diarization):
 *
 * - a dependency that APPLIES to the item but has no row yet is "on its way"
 *   (its extractor will append a row soon) — wait for it;
 * - a `succeeded` dependency must apply and have succeeded; if it can never
 *   apply, the extractor can never run on this item;
 * - a `settled` dependency is waited for while in flight but tolerated when
 *   failed or not applicable;
 * - any dependency still `queued`/`processing` means wait.
 *
 * Pure function so it is unit-testable and shared by the event-driven
 * pipeline and backfill runs.
 */
export function evaluateReadiness(
  extractor: Extractor,
  item: InboxItemEntity,
  graph: ExtractorGraph,
): Readiness {
  let generationTs = 0;
  for (const dep of extractor.dependsOn) {
    const depExtractor = graph.get(dep.kind);
    const depApplies =
      depExtractor !== undefined && depExtractor.enabled() && depExtractor.appliesTo(item);
    const latest = latestOfKind(item.extractions ?? [], dep.kind);

    if (!latest) {
      if (depApplies) {
        return { ready: false, reason: `waiting for '${dep.kind}' to start` };
      }
      if (dep.requires === 'succeeded') {
        return { ready: false, reason: `required dependency '${dep.kind}' does not apply` };
      }
      continue; // settled dependency that does not apply — proceed without it
    }
    if (ACTIVE_STATUSES.includes(latest.status)) {
      return { ready: false, reason: `'${dep.kind}' is still in flight` };
    }
    if (dep.requires === 'succeeded' && latest.status !== 'succeeded') {
      return { ready: false, reason: `required dependency '${dep.kind}' did not succeed` };
    }
    generationTs = Math.max(generationTs, ts(latest.createdAt));
  }
  return { ready: true, generationTs };
}

/**
 * Whether the latest row of `kind` already covers the given generation — i.e.
 * it was appended at/after every dependency attempt it would consume and is
 * not failed. Used to dedupe the event-driven pipeline (never two rows for
 * one generation) without ever blocking an explicit retry/backfill.
 */
export function isGenerationCovered(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractionKind,
  generationTs: number,
): boolean {
  const latest = latestOfKind(extractions, kind);
  if (!latest) return false;
  if (ts(latest.createdAt) < generationTs) return false;
  return latest.status === 'succeeded' || ACTIVE_STATUSES.includes(latest.status);
}

export function isActive(status: ExtractionStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function latestOfKind(
  extractions: ExtractedPayloadEntity[],
  kind: ExtractionKind,
): ExtractedPayloadEntity | undefined {
  return extractions
    .filter((e) => e.kind === kind)
    .slice()
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
}

export function ts(value: Date | string): number {
  return new Date(value).getTime();
}

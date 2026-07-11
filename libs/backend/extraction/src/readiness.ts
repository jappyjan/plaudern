import type { ExtractionKind, ExtractionStatus } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
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
 * - any dependency still `queued`/`processing` means wait;
 * - dependencies sharing a `group` are OR'd: the group is ready once any member
 *   satisfies its `requires`, waits while a member is still on its way, and can
 *   never run only if no member can ever satisfy it (JJ-83's transcription-OR-ocr
 *   "source text" group).
 *
 * Pure function so it is unit-testable and shared by the event-driven
 * pipeline and backfill runs.
 */
export async function evaluateReadiness(
  extractor: Extractor,
  item: InboxItemEntity,
  graph: ExtractorGraph,
): Promise<Readiness> {
  const extractions = item.extractions ?? [];
  let generationTs = 0;

  // Plain (AND) dependencies keep their exact prior semantics; grouped (OR)
  // dependencies are collected and evaluated together below.
  const groups = new Map<string, ExtractorDependency[]>();
  for (const dep of extractor.dependsOn) {
    if (dep.group !== undefined) {
      const members = groups.get(dep.group) ?? [];
      members.push(dep);
      groups.set(dep.group, members);
      continue;
    }
    const outcome = await evaluatePlainDep(dep, item, graph, extractions);
    if (!outcome.ready) return outcome;
    generationTs = Math.max(generationTs, outcome.generationTs);
  }

  for (const [key, members] of groups) {
    const outcome = await evaluateGroup(key, members, item, graph, extractions);
    if (!outcome.ready) return outcome;
    generationTs = Math.max(generationTs, outcome.generationTs);
  }

  return { ready: true, generationTs };
}

type DepOutcome = { ready: true; generationTs: number } | { ready: false; reason: string };

/** One ungrouped dependency — the historical AND evaluation, unchanged. */
async function evaluatePlainDep(
  dep: ExtractorDependency,
  item: InboxItemEntity,
  graph: ExtractorGraph,
  extractions: ExtractedPayloadEntity[],
): Promise<DepOutcome> {
  const depApplies = await dependencyApplies(dep, item, graph);
  const latest = latestOfKind(extractions, dep.kind);

  if (!latest) {
    if (depApplies) {
      return { ready: false, reason: `waiting for '${dep.kind}' to start` };
    }
    if (dep.requires === 'succeeded') {
      return { ready: false, reason: `required dependency '${dep.kind}' does not apply` };
    }
    return { ready: true, generationTs: 0 }; // settled dependency that does not apply
  }
  if (ACTIVE_STATUSES.includes(latest.status)) {
    return { ready: false, reason: `'${dep.kind}' is still in flight` };
  }
  if (dep.requires === 'succeeded' && latest.status !== 'succeeded') {
    return { ready: false, reason: `required dependency '${dep.kind}' did not succeed` };
  }
  return { ready: true, generationTs: ts(latest.createdAt) };
}

/**
 * An OR-group: ready once ANY member satisfies its `requires`. A member with no
 * row yet that still applies (or an in-flight member) keeps the group waiting;
 * only when no member can ever satisfy it does the group block the extractor
 * for good. The generation is the newest satisfying member's timestamp so the
 * dedup gate still fires exactly once per input generation.
 */
async function evaluateGroup(
  groupKey: string,
  members: ExtractorDependency[],
  item: InboxItemEntity,
  graph: ExtractorGraph,
  extractions: ExtractedPayloadEntity[],
): Promise<DepOutcome> {
  let satisfiedTs = 0;
  let anySatisfied = false;
  let anyPending = false;

  for (const dep of members) {
    const latest = latestOfKind(extractions, dep.kind);
    if (!latest) {
      if (await dependencyApplies(dep, item, graph)) anyPending = true;
      continue;
    }
    if (ACTIVE_STATUSES.includes(latest.status)) {
      anyPending = true;
      continue;
    }
    const satisfies = dep.requires === 'succeeded' ? latest.status === 'succeeded' : true;
    if (satisfies) {
      anySatisfied = true;
      satisfiedTs = Math.max(satisfiedTs, ts(latest.createdAt));
    }
  }

  if (anySatisfied) return { ready: true, generationTs: satisfiedTs };
  const kinds = members.map((m) => `'${m.kind}'`).join(', ');
  if (anyPending) return { ready: false, reason: `waiting for one of [${kinds}] (${groupKey})` };
  return { ready: false, reason: `no dependency in [${kinds}] can satisfy '${groupKey}'` };
}

async function dependencyApplies(
  dep: ExtractorDependency,
  item: InboxItemEntity,
  graph: ExtractorGraph,
): Promise<boolean> {
  const depExtractor = graph.get(dep.kind);
  return (
    depExtractor !== undefined &&
    (await depExtractor.enabled(item.userId)) &&
    depExtractor.appliesTo(item)
  );
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

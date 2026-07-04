import type { EntityRelationEdgeDto } from '@plaudern/contracts';

/**
 * A stable identity for an aggregated edge. The backend already canonicalises
 * symmetric relations (smaller id first) so (source, target, type) is unique.
 */
export function edgeKey(edge: {
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
}): string {
  return `${edge.sourceEntityId}:${edge.targetEntityId}:${edge.relationType}`;
}

/** Confidence stamped on implicit co-occurrence edges (mirrors the backend). */
export const COOCCURRENCE_CONFIDENCE = 0.2;

/**
 * The confidence a min-confidence filter should test an edge against: explicit
 * LLM edges without a reported number are treated as fully confident (they were
 * an intentional assertion), co-occurrence edges use their weak fixed score.
 */
export function effectiveConfidence(edge: EntityRelationEdgeDto): number {
  if (edge.confidence != null) return edge.confidence;
  return edge.origin === 'cooccurrence' ? COOCCURRENCE_CONFIDENCE : 1;
}

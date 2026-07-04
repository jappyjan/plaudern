import type { ExtractionKind, ExtractorNodeDto } from '@plaudern/contracts';
import type { Extractor } from '@plaudern/inbox';

/**
 * The declarative extractor DAG (VISION §8). Built once at boot from the
 * DI-collected extractors; construction validates the declaration so a broken
 * graph (duplicate kind, edge to an unregistered kind, cycle) fails fast at
 * startup instead of silently stalling items at runtime.
 *
 * The graph is pure structure — it holds WHO depends on WHOM. Scheduling
 * (when to enqueue) lives in ExtractionPipelineService; execution (queues,
 * providers) stays inside each extractor's own module.
 */
export class ExtractorGraph {
  private readonly byKind = new Map<ExtractionKind, Extractor>();
  private readonly dependents = new Map<ExtractionKind, Extractor[]>();

  constructor(extractors: Extractor[]) {
    for (const extractor of extractors) {
      if (this.byKind.has(extractor.kind)) {
        throw new Error(`extractor graph: duplicate extractor for kind '${extractor.kind}'`);
      }
      this.byKind.set(extractor.kind, extractor);
    }
    for (const extractor of extractors) {
      const seen = new Set<ExtractionKind>();
      for (const dep of extractor.dependsOn) {
        if (!this.byKind.has(dep.kind)) {
          throw new Error(
            `extractor graph: '${extractor.kind}' depends on unregistered kind '${dep.kind}'`,
          );
        }
        if (dep.kind === extractor.kind) {
          throw new Error(`extractor graph: '${extractor.kind}' depends on itself`);
        }
        if (seen.has(dep.kind)) {
          throw new Error(
            `extractor graph: '${extractor.kind}' declares duplicate dependency on '${dep.kind}'`,
          );
        }
        seen.add(dep.kind);
        const list = this.dependents.get(dep.kind) ?? [];
        list.push(extractor);
        this.dependents.set(dep.kind, list);
      }
    }
    this.assertAcyclic();
  }

  /** All registered extractors (declaration order). */
  all(): Extractor[] {
    return [...this.byKind.values()];
  }

  get(kind: ExtractionKind): Extractor | undefined {
    return this.byKind.get(kind);
  }

  /** Extractors with no dependencies — they run directly on commit/reprocess. */
  roots(): Extractor[] {
    return this.all().filter((extractor) => extractor.dependsOn.length === 0);
  }

  /** Extractors that declare a dependency on `kind` (direct edges only). */
  dependentsOf(kind: ExtractionKind): Extractor[] {
    return this.dependents.get(kind) ?? [];
  }

  /** Introspection DTO for GET /v1/extractions/graph. */
  toDto(): ExtractorNodeDto[] {
    return this.all().map((extractor) => ({
      kind: extractor.kind,
      version: extractor.version,
      enabled: extractor.enabled(),
      dependsOn: extractor.dependsOn.map((dep) => ({ kind: dep.kind, requires: dep.requires })),
    }));
  }

  /** Kahn's algorithm: if not every node can be topologically ordered, there is a cycle. */
  private assertAcyclic(): void {
    const inDegree = new Map<ExtractionKind, number>();
    for (const extractor of this.byKind.values()) {
      inDegree.set(extractor.kind, extractor.dependsOn.length);
    }
    const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([k]) => k);
    let visited = 0;
    while (queue.length > 0) {
      const kind = queue.shift() as ExtractionKind;
      visited += 1;
      for (const dependent of this.dependentsOf(kind)) {
        const remaining = (inDegree.get(dependent.kind) ?? 0) - 1;
        inDegree.set(dependent.kind, remaining);
        if (remaining === 0) queue.push(dependent.kind);
      }
    }
    if (visited !== this.byKind.size) {
      const stuck = [...inDegree.entries()]
        .filter(([, d]) => d > 0)
        .map(([k]) => k)
        .join(', ');
      throw new Error(`extractor graph: dependency cycle involving [${stuck}]`);
    }
  }
}

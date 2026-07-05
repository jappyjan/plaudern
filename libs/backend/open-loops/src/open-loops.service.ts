import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type {
  OpenLoopDto,
  OpenLoopKind,
  OpenLoopListQuery,
  OpenLoopState,
} from '@plaudern/contracts';
import { OPEN_LOOP_SOURCES, rankOpenLoops, type OpenLoopSource } from './open-loop-source';

/**
 * The unified open-loop ledger (JJ-29). A pure read-side aggregation: it fans a
 * query out over every registered `OpenLoopSource`, merges their normalized
 * rows, applies the requested filters, and ranks the result by age + importance
 * (`rankOpenLoops`). It owns no table — state mutations are routed straight back
 * to the source that owns the row, so durability against re-extraction is the
 * source's guarantee, not ours.
 */
@Injectable()
export class OpenLoopsService {
  private readonly sources: Map<OpenLoopKind, OpenLoopSource>;

  constructor(@Inject(OPEN_LOOP_SOURCES) sources: OpenLoopSource[]) {
    this.sources = new Map(sources.map((s) => [s.kind, s]));
  }

  /** The ranked ledger for a user, honoring the kind / direction / resolved filters. */
  async list(userId: string, query: OpenLoopListQuery): Promise<OpenLoopDto[]> {
    // Only query the sources the filter can match; a `direction` filter implies
    // commitments (the only directional kind).
    const kinds = query.kind
      ? [query.kind]
      : query.direction
        ? (['commitment'] as OpenLoopKind[])
        : [...this.sources.keys()];

    const batches = await Promise.all(
      kinds
        .map((kind) => this.sources.get(kind))
        .filter((s): s is OpenLoopSource => s !== undefined)
        .map((source) => source.list(userId, query.includeResolved)),
    );

    let loops = batches.flat();
    if (query.direction) loops = loops.filter((l) => l.direction === query.direction);

    return rankOpenLoops(loops, Date.now());
  }

  /** Advance one loop's state, routing to the source that owns its kind. */
  async updateState(
    userId: string,
    kind: OpenLoopKind,
    id: string,
    state: OpenLoopState,
  ): Promise<OpenLoopDto> {
    const source = this.sources.get(kind);
    if (!source) throw new BadRequestException(`unknown open-loop kind: ${kind}`);
    const updated = await source.updateState(userId, id, state);
    return { ...updated, score: 0 };
  }
}

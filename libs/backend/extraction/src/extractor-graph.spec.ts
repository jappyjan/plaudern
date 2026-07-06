import type { ExtractionKind } from '@plaudern/contracts';
import type { Extractor, ExtractorDependency } from '@plaudern/inbox';
import type { ExtractedPayloadEntity, InboxItemEntity } from '@plaudern/persistence';
import { ExtractorGraph } from './extractor-graph';
import { evaluateReadiness, isGenerationCovered } from './readiness';

/** Minimal declarative extractor for exercising the pure graph machinery. */
function extractor(
  kind: ExtractionKind,
  dependsOn: ExtractorDependency[] = [],
  overrides: Partial<Pick<Extractor, 'enabled' | 'appliesTo'>> & { version?: number } = {},
): Extractor {
  return {
    kind,
    version: overrides.version ?? 1,
    dependsOn,
    enabled: overrides.enabled ?? (async () => true),
    appliesTo: overrides.appliesTo ?? (() => true),
    enqueue: async () => 'extraction-id',
  };
}

function row(
  kind: ExtractionKind,
  status: ExtractedPayloadEntity['status'],
  createdAt: string,
): ExtractedPayloadEntity {
  return { kind, status, createdAt: new Date(createdAt) } as ExtractedPayloadEntity;
}

function item(extractions: ExtractedPayloadEntity[]): InboxItemEntity {
  return { id: 'item-1', userId: 'user-1', extractions } as InboxItemEntity;
}

describe('ExtractorGraph (declaration validation)', () => {
  it('accepts the real-world shape: two roots + one dependent', () => {
    const graph = new ExtractorGraph([
      extractor('transcription'),
      extractor('diarization'),
      extractor('summary', [
        { kind: 'transcription', requires: 'succeeded' },
        { kind: 'diarization', requires: 'settled' },
      ]),
    ]);
    expect(graph.roots().map((e) => e.kind).sort()).toEqual(['diarization', 'transcription']);
    expect(graph.dependentsOf('transcription').map((e) => e.kind)).toEqual(['summary']);
    expect(graph.dependentsOf('diarization').map((e) => e.kind)).toEqual(['summary']);
    expect(graph.dependentsOf('summary')).toEqual([]);
  });

  it('rejects duplicate registrations of one kind', () => {
    expect(
      () => new ExtractorGraph([extractor('transcription'), extractor('transcription')]),
    ).toThrow(/duplicate extractor for kind 'transcription'/);
  });

  it('rejects an edge to an unregistered kind', () => {
    expect(
      () =>
        new ExtractorGraph([
          extractor('summary', [{ kind: 'transcription', requires: 'succeeded' }]),
        ]),
    ).toThrow(/depends on unregistered kind 'transcription'/);
  });

  it('rejects a self-dependency', () => {
    expect(
      () => new ExtractorGraph([extractor('summary', [{ kind: 'summary', requires: 'settled' }])]),
    ).toThrow(/depends on itself/);
  });

  it('rejects duplicate dependency declarations', () => {
    expect(
      () =>
        new ExtractorGraph([
          extractor('transcription'),
          extractor('summary', [
            { kind: 'transcription', requires: 'succeeded' },
            { kind: 'transcription', requires: 'settled' },
          ]),
        ]),
    ).toThrow(/duplicate dependency on 'transcription'/);
  });

  it('rejects dependency cycles', () => {
    expect(
      () =>
        new ExtractorGraph([
          extractor('transcription', [{ kind: 'summary', requires: 'settled' }]),
          extractor('summary', [{ kind: 'transcription', requires: 'succeeded' }]),
        ]),
    ).toThrow(/dependency cycle/);
  });

  it('exposes the graph as an introspection DTO', async () => {
    const graph = new ExtractorGraph([
      extractor('transcription', [], { version: 3 }),
      extractor('summary', [{ kind: 'transcription', requires: 'succeeded' }], {
        enabled: async () => false,
      }),
    ]);
    expect(await graph.toDto('user-1')).toEqual([
      { kind: 'transcription', version: 3, enabled: true, dependsOn: [] },
      {
        kind: 'summary',
        version: 1,
        enabled: false,
        dependsOn: [{ kind: 'transcription', requires: 'succeeded' }],
      },
    ]);
  });
});

describe('evaluateReadiness (the generic dependency gate)', () => {
  const graph = new ExtractorGraph([
    extractor('transcription'),
    extractor('diarization'),
    extractor('summary', [
      { kind: 'transcription', requires: 'succeeded' },
      { kind: 'diarization', requires: 'settled' },
    ]),
  ]);
  const summary = graph.get('summary')!;

  it('is ready once the required dep succeeded and the settled dep is terminal (even failed)', async () => {
    const readiness = await evaluateReadiness(
      summary,
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z'),
        row('diarization', 'failed', '2026-07-01T10:05:00Z'),
      ]),
      graph,
    );
    expect(readiness).toEqual({
      ready: true,
      generationTs: new Date('2026-07-01T10:05:00Z').getTime(),
    });
  });

  it('waits while a dependency is still in flight', async () => {
    const readiness = await evaluateReadiness(
      summary,
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z'),
        row('diarization', 'processing', '2026-07-01T10:05:00Z'),
      ]),
      graph,
    );
    expect(readiness.ready).toBe(false);
  });

  it('waits for an applicable dependency whose row has not been appended yet', async () => {
    // Diarization applies to the item but its row is on its way — the old
    // SummarizationTrigger `expectsDiarization` behavior.
    const readiness = await evaluateReadiness(
      summary,
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z')]),
      graph,
    );
    expect(readiness.ready).toBe(false);
  });

  it('proceeds without a settled dependency that does not apply (speaker id off)', async () => {
    const offGraph = new ExtractorGraph([
      extractor('transcription'),
      extractor('diarization', [], { enabled: async () => false }),
      extractor('summary', [
        { kind: 'transcription', requires: 'succeeded' },
        { kind: 'diarization', requires: 'settled' },
      ]),
    ]);
    const readiness = await evaluateReadiness(
      offGraph.get('summary')!,
      item([row('transcription', 'succeeded', '2026-07-01T10:00:00Z')]),
      offGraph,
    );
    expect(readiness.ready).toBe(true);
  });

  it('never becomes ready when a required dependency failed', async () => {
    const readiness = await evaluateReadiness(
      summary,
      item([
        row('transcription', 'failed', '2026-07-01T10:00:00Z'),
        row('diarization', 'succeeded', '2026-07-01T10:05:00Z'),
      ]),
      graph,
    );
    expect(readiness.ready).toBe(false);
  });

  it('never becomes ready when a required dependency cannot apply (text item)', async () => {
    const textGraph = new ExtractorGraph([
      extractor('transcription', [], { appliesTo: () => false }),
      extractor('diarization', [], { appliesTo: () => false }),
      extractor('summary', [
        { kind: 'transcription', requires: 'succeeded' },
        { kind: 'diarization', requires: 'settled' },
      ]),
    ]);
    const readiness = await evaluateReadiness(textGraph.get('summary')!, item([]), textGraph);
    expect(readiness.ready).toBe(false);
  });

  it('only judges the LATEST attempt of each dependency (append-only history)', async () => {
    const readiness = await evaluateReadiness(
      summary,
      item([
        row('transcription', 'succeeded', '2026-07-01T10:00:00Z'),
        row('transcription', 'failed', '2026-07-01T11:00:00Z'), // latest failed
        row('diarization', 'succeeded', '2026-07-01T10:05:00Z'),
      ]),
      graph,
    );
    expect(readiness.ready).toBe(false);
  });
});

describe('isGenerationCovered (event-pipeline dedupe)', () => {
  const generationTs = new Date('2026-07-01T10:05:00Z').getTime();

  it('is covered while a newer attempt is succeeded or in flight', () => {
    for (const status of ['succeeded', 'queued', 'processing'] as const) {
      expect(
        isGenerationCovered([row('summary', status, '2026-07-01T10:06:00Z')], 'summary', generationTs),
      ).toBe(true);
    }
  });

  it('is not covered by an older attempt, a failed attempt, or no attempt', () => {
    expect(isGenerationCovered([], 'summary', generationTs)).toBe(false);
    expect(
      isGenerationCovered([row('summary', 'succeeded', '2026-07-01T10:00:00Z')], 'summary', generationTs),
    ).toBe(false);
    expect(
      isGenerationCovered([row('summary', 'failed', '2026-07-01T10:06:00Z')], 'summary', generationTs),
    ).toBe(false);
  });
});

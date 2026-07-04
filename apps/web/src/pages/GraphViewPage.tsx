import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Chip, Spinner } from '@heroui/react';
import type {
  EntityRelationEdgeDto,
  GraphEntityDto,
  RegistryEntityDto,
  RelationType,
} from '@plaudern/contracts';
import { Link, useSearchParams } from 'react-router-dom';
import { connectEntities, getEntityNeighborhood, listEntities } from '../lib/api';
import {
  ENTITY_TYPE_HEX,
  ENTITY_TYPE_LABEL,
  ENTITY_TYPES,
  RELATION_TYPE_LABEL,
  RELATION_TYPES,
} from '../lib/entityLabels';
import { GraphCanvas } from '../components/graph/GraphCanvas';
import { edgeKey, effectiveConfidence } from '../components/graph/graphModel';
import { BackIcon } from '../components/icons';

/** Hard ceiling on rendered nodes so a hub entity can't melt an iPhone. */
const MAX_RENDERED_NODES = 110;

type OriginFilter = 'all' | 'llm' | 'cooccurrence';

interface Filters {
  relationTypes: Set<RelationType>;
  origin: OriginFilter;
  minConfidence: number; // 0..1
}

const ALL_RELATIONS = new Set<RelationType>(RELATION_TYPES);

/**
 * Interactive knowledge-graph view (JJ-62): a pan/zoom, tap-to-expand force
 * layout over the per-user entity graph. Seeds from an entity (or the most-
 * mentioned one), grows a node's neighbourhood on tap, filters edges by
 * relation type / origin / confidence, and — in connect mode — highlights the
 * paths the backend finds between 2–3 chosen entities. All overlays are plain
 * positioned divs (no HeroUI modals) so iOS Safari never drops an open.
 */
export function GraphViewPage() {
  const [params] = useSearchParams();
  const seedParam = params.get('seed');

  const [entities, setEntities] = useState<Map<string, GraphEntityDto>>(new Map());
  const [edges, setEdges] = useState<Map<string, EntityRelationEdgeDto>>(new Map());
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const expandingRef = useRef<Set<string>>(new Set());

  const [filters, setFilters] = useState<Filters>({
    relationTypes: new Set(ALL_RELATIONS),
    origin: 'all',
    minConfidence: 0,
  });
  const [showFilters, setShowFilters] = useState(false);

  const [mode, setMode] = useState<'explore' | 'connect'>('explore');
  const [connectIds, setConnectIds] = useState<string[]>([]);
  const [connectStatus, setConnectStatus] = useState<
    { connected: boolean; truncated: boolean; nodes: Set<string>; edges: Set<string> } | null
  >(null);
  const [connecting, setConnecting] = useState(false);

  const [focusId, setFocusId] = useState<string | null>(null);
  const [picker, setPicker] = useState<RegistryEntityDto[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);

  const mergeGraph = useCallback(
    (newEntities: GraphEntityDto[], newEdges: EntityRelationEdgeDto[]) => {
      setEntities((prev) => {
        const next = new Map(prev);
        for (const e of newEntities) next.set(e.id, e);
        return next;
      });
      setEdges((prev) => {
        const next = new Map(prev);
        for (const e of newEdges) next.set(edgeKey(e), e);
        return next;
      });
    },
    [],
  );

  const expand = useCallback(
    async (id: string) => {
      if (expandingRef.current.has(id)) return;
      expandingRef.current.add(id);
      try {
        const hood = await getEntityNeighborhood(id);
        mergeGraph([hood.entity, ...hood.neighbors], hood.relations);
        setExpandedIds((prev) => new Set(prev).add(id));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        expandingRef.current.delete(id);
      }
    },
    [mergeGraph],
  );

  // Initial seed: the ?seed entity, else the most-mentioned entity in the
  // registry so the canvas is never empty. The entity list also backs the
  // "add entity" picker.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await listEntities();
        if (cancelled) return;
        setPicker(list.entities);
        const seedId =
          seedParam ??
          [...list.entities].sort((a, b) => b.mentionCount - a.mentionCount)[0]?.id ??
          null;
        if (seedId) await expand(seedId);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedParam]);

  // Filtered edges + the nodes they touch, capped. Explicitly-loaded seeds,
  // the focused node, connect selections and path nodes are always kept.
  const { visibleNodes, visibleEdges } = useMemo(() => {
    const passing = [...edges.values()].filter((e) => {
      if (!filters.relationTypes.has(e.relationType)) return false;
      if (filters.origin !== 'all' && e.origin !== filters.origin) return false;
      if (filters.minConfidence > 0 && effectiveConfidence(e) < filters.minConfidence) return false;
      return true;
    });

    const degree = new Map<string, number>();
    for (const e of passing) {
      degree.set(e.sourceEntityId, (degree.get(e.sourceEntityId) ?? 0) + 1);
      degree.set(e.targetEntityId, (degree.get(e.targetEntityId) ?? 0) + 1);
    }

    const pinned = new Set<string>([
      ...expandedIds,
      ...connectIds,
      ...(focusId ? [focusId] : []),
      ...(connectStatus?.nodes ?? []),
    ]);

    const candidateIds = new Set<string>([...pinned].filter((id) => entities.has(id)));
    for (const id of degree.keys()) candidateIds.add(id);

    let keptIds: Set<string>;
    if (candidateIds.size <= MAX_RENDERED_NODES) {
      keptIds = candidateIds;
    } else {
      const ranked = [...candidateIds].sort((a, b) => {
        const pinnedDelta = Number(pinned.has(b)) - Number(pinned.has(a));
        if (pinnedDelta !== 0) return pinnedDelta;
        return (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
      });
      keptIds = new Set(ranked.slice(0, MAX_RENDERED_NODES));
    }

    const nodes: GraphEntityDto[] = [];
    for (const id of keptIds) {
      const ent = entities.get(id);
      if (ent) nodes.push(ent);
    }
    const shownEdges = passing.filter(
      (e) => keptIds.has(e.sourceEntityId) && keptIds.has(e.targetEntityId),
    );
    return { visibleNodes: nodes, visibleEdges: shownEdges };
  }, [edges, entities, filters, expandedIds, connectIds, focusId, connectStatus]);

  const handleTapNode = useCallback(
    (id: string) => {
      if (mode === 'connect') {
        setConnectIds((prev) => {
          if (prev.includes(id)) return prev.filter((x) => x !== id);
          if (prev.length >= 3) return prev;
          return [...prev, id];
        });
        return;
      }
      setFocusId(id);
      if (!expandedIds.has(id)) void expand(id);
    },
    [mode, expandedIds, expand],
  );

  const runConnect = useCallback(async () => {
    if (connectIds.length < 2) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await connectEntities(connectIds);
      mergeGraph(res.entities, res.relations);
      setConnectStatus({
        connected: res.connected,
        truncated: res.truncated,
        nodes: new Set(res.entities.map((e) => e.id)),
        edges: new Set(res.relations.map(edgeKey)),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setConnecting(false);
    }
  }, [connectIds, mergeGraph]);

  const clearConnect = () => {
    setConnectIds([]);
    setConnectStatus(null);
  };

  const seedFromPicker = (ent: RegistryEntityDto) => {
    setShowPicker(false);
    setFocusId(ent.id);
    void expand(ent.id);
  };

  const focusEntity = focusId ? entities.get(focusId) : undefined;
  const activeFilterCount =
    (filters.relationTypes.size < ALL_RELATIONS.size ? 1 : 0) +
    (filters.origin !== 'all' ? 1 : 0) +
    (filters.minConfidence > 0 ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button
          as={Link}
          to="/entities"
          variant="light"
          size="sm"
          startContent={<BackIcon className="h-4 w-4" />}
        >
          Entities
        </Button>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={showFilters ? 'solid' : 'flat'}
            onPress={() => setShowFilters((v) => !v)}
          >
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </Button>
          <Button
            size="sm"
            color={mode === 'connect' ? 'primary' : 'default'}
            variant={mode === 'connect' ? 'solid' : 'flat'}
            onPress={() => {
              setMode((m) => (m === 'connect' ? 'explore' : 'connect'));
              setFocusId(null);
            }}
          >
            Connect
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-medium bg-danger-50 p-2 text-xs text-danger">{error}</div>
      )}

      <div className="relative h-[68dvh] w-full overflow-hidden rounded-large border border-default-200 bg-default-50 text-default-600">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label="Loading graph…" />
          </div>
        ) : visibleNodes.length === 0 ? (
          <EmptyGraph hasData={entities.size > 0} />
        ) : (
          <GraphCanvas
            nodes={visibleNodes}
            edges={visibleEdges}
            selectedIds={new Set(connectIds)}
            focusId={mode === 'explore' ? focusId : null}
            highlightedNodeIds={connectStatus?.nodes ?? new Set()}
            highlightedEdgeKeys={connectStatus?.edges ?? new Set()}
            expandedIds={expandedIds}
            onTapNode={handleTapNode}
            onTapBackground={() => setFocusId(null)}
          />
        )}

        {/* status pills (top-left) */}
        <div className="pointer-events-none absolute left-2 top-2 flex flex-col items-start gap-1">
          <Chip size="sm" variant="flat" className="pointer-events-auto bg-default-100/90">
            {visibleNodes.length} shown
          </Chip>
          {connectStatus && (
            <Chip
              size="sm"
              variant="flat"
              color={connectStatus.connected ? 'success' : 'warning'}
              className="pointer-events-auto"
            >
              {connectStatus.connected ? 'Path found' : 'No full path'}
              {connectStatus.truncated ? ' · truncated' : ''}
            </Chip>
          )}
        </div>

        {/* add-entity (top-right) */}
        <div className="absolute right-2 top-2 flex gap-1">
          <Button
            size="sm"
            variant="flat"
            className="bg-default-100/90"
            onPress={() => setShowPicker((v) => !v)}
          >
            + Entity
          </Button>
        </div>

        {showFilters && (
          <FilterSheet
            filters={filters}
            onChange={setFilters}
            onClose={() => setShowFilters(false)}
          />
        )}

        {showPicker && picker && (
          <PickerSheet
            entities={picker}
            onPick={seedFromPicker}
            onClose={() => setShowPicker(false)}
          />
        )}

        {mode === 'connect' && (
          <ConnectBar
            ids={connectIds}
            entities={entities}
            connecting={connecting}
            onRun={runConnect}
            onClear={clearConnect}
            onRemove={(id) => setConnectIds((prev) => prev.filter((x) => x !== id))}
          />
        )}

        {mode === 'explore' && focusEntity && (
          <NodeSheet
            entity={focusEntity}
            expanded={expandedIds.has(focusEntity.id)}
            onExpand={() => void expand(focusEntity.id)}
            onConnect={() => {
              setMode('connect');
              setConnectIds([focusEntity.id]);
              setFocusId(null);
            }}
            onClose={() => setFocusId(null)}
          />
        )}
      </div>

      <Legend />
    </div>
  );
}

function EmptyGraph({ hasData }: { hasData: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm font-medium">
        {hasData ? 'No edges match your filters' : 'No graph yet'}
      </p>
      <p className="max-w-xs text-xs text-default-500">
        {hasData
          ? 'Loosen the relation-type, origin or confidence filters to see connections.'
          : 'Relations appear as recordings mentioning entities together are processed. Add an entity to start exploring.'}
      </p>
    </div>
  );
}

/** Shared bottom-sheet shell: a plain positioned div, never a HeroUI modal. */
function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 max-h-[70%] overflow-y-auto rounded-t-large border-t border-default-200 bg-background/95 p-3 shadow-lg backdrop-blur">
      <div className="mb-2 flex justify-end">
        <Button size="sm" variant="light" isIconOnly aria-label="Close" onPress={onClose}>
          ✕
        </Button>
      </div>
      {children}
    </div>
  );
}

function FilterSheet({
  filters,
  onChange,
  onClose,
}: {
  filters: Filters;
  onChange: (f: Filters) => void;
  onClose: () => void;
}) {
  const toggleRelation = (rt: RelationType) => {
    const next = new Set(filters.relationTypes);
    if (next.has(rt)) next.delete(rt);
    else next.add(rt);
    onChange({ ...filters, relationTypes: next });
  };
  return (
    <Sheet onClose={onClose}>
      <div className="flex flex-col gap-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-default-600">Relation types</p>
          <div className="flex flex-wrap gap-1">
            {RELATION_TYPES.map((rt) => {
              const on = filters.relationTypes.has(rt);
              return (
                <button
                  key={rt}
                  type="button"
                  onClick={() => toggleRelation(rt)}
                  className={`rounded-full px-2 py-1 text-xs ${
                    on ? 'bg-primary text-primary-foreground' : 'bg-default-100 text-default-500'
                  }`}
                >
                  {RELATION_TYPE_LABEL[rt]}
                </button>
              );
            })}
          </div>
          <div className="mt-1 flex gap-2 text-xs">
            <button
              type="button"
              className="text-primary"
              onClick={() => onChange({ ...filters, relationTypes: new Set(ALL_RELATIONS) })}
            >
              All
            </button>
            <button
              type="button"
              className="text-primary"
              onClick={() => onChange({ ...filters, relationTypes: new Set() })}
            >
              None
            </button>
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-default-600">Origin</p>
          <div className="flex gap-1">
            {(
              [
                ['all', 'All'],
                ['llm', 'Stated'],
                ['cooccurrence', 'Co-occurrence'],
              ] as [OriginFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => onChange({ ...filters, origin: value })}
                className={`rounded-full px-2 py-1 text-xs ${
                  filters.origin === value
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-default-100 text-default-500'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-semibold text-default-600">
            Min confidence: {Math.round(filters.minConfidence * 100)}%
          </p>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(filters.minConfidence * 100)}
            onChange={(e) => onChange({ ...filters, minConfidence: Number(e.target.value) / 100 })}
            className="w-full accent-primary"
          />
        </div>
      </div>
    </Sheet>
  );
}

function PickerSheet({
  entities,
  onPick,
  onClose,
}: {
  entities: RegistryEntityDto[];
  onPick: (e: RegistryEntityDto) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const filtered = entities
    .filter((e) => !needle || e.canonicalName.toLowerCase().includes(needle))
    .slice(0, 40);
  return (
    <Sheet onClose={onClose}>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search entities to add…"
        className="mb-2 w-full rounded-medium border border-default-200 bg-default-50 px-3 py-2 text-sm outline-none"
      />
      <div className="flex flex-col gap-1">
        {filtered.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => onPick(e)}
            className="flex items-center justify-between gap-2 rounded-medium px-2 py-2 text-left hover:bg-default-100"
          >
            <span className="truncate text-sm">{e.canonicalName}</span>
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] text-white"
              style={{ backgroundColor: ENTITY_TYPE_HEX[e.type] }}
            >
              {ENTITY_TYPE_LABEL[e.type]}
            </span>
          </button>
        ))}
        {filtered.length === 0 && <p className="text-xs text-default-500">No matches.</p>}
      </div>
    </Sheet>
  );
}

function ConnectBar({
  ids,
  entities,
  connecting,
  onRun,
  onClear,
  onRemove,
}: {
  ids: string[];
  entities: Map<string, GraphEntityDto>;
  connecting: boolean;
  onRun: () => void;
  onClear: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-default-200 bg-background/95 p-2 backdrop-blur">
      <p className="mb-1 text-[11px] text-default-500">
        Tap 2–3 entities to connect, then find the paths between them.
      </p>
      <div className="mb-2 flex flex-wrap gap-1">
        {ids.length === 0 && <span className="text-xs text-default-400">None selected</span>}
        {ids.map((id, i) => (
          <Chip
            key={id}
            size="sm"
            variant="flat"
            color={i === 0 ? 'primary' : 'default'}
            onClose={() => onRemove(id)}
          >
            {entities.get(id)?.canonicalName ?? id.slice(0, 6)}
          </Chip>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          color="primary"
          isDisabled={ids.length < 2 || connecting}
          isLoading={connecting}
          onPress={onRun}
        >
          Find paths
        </Button>
        <Button size="sm" variant="flat" onPress={onClear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

function NodeSheet({
  entity,
  expanded,
  onExpand,
  onConnect,
  onClose,
}: {
  entity: GraphEntityDto;
  expanded: boolean;
  onExpand: () => void;
  onConnect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-10 border-t border-default-200 bg-background/95 p-3 backdrop-blur">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{entity.canonicalName}</p>
          <span
            className="mt-1 inline-block rounded-full px-1.5 py-0.5 text-[10px] text-white"
            style={{ backgroundColor: ENTITY_TYPE_HEX[entity.type] }}
          >
            {ENTITY_TYPE_LABEL[entity.type]}
          </span>
        </div>
        <Button size="sm" variant="light" isIconOnly aria-label="Close" onPress={onClose}>
          ✕
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="flat" isDisabled={expanded} onPress={onExpand}>
          {expanded ? 'Neighbourhood loaded' : 'Expand neighbourhood'}
        </Button>
        <Button size="sm" variant="flat" onPress={onConnect}>
          Connect from here
        </Button>
        <Button as={Link} to={`/entities/${entity.id}`} size="sm" variant="flat">
          Open entity
        </Button>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[10px] text-default-500">
      {ENTITY_TYPES.map((t) => (
        <span key={t} className="flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: ENTITY_TYPE_HEX[t] }}
          />
          {ENTITY_TYPE_LABEL[t]}
        </span>
      ))}
      <span className="flex items-center gap-1">
        <span className="inline-block h-0 w-4 border-t border-dashed border-default-400" />
        co-occurrence
      </span>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { EntityRelationEdgeDto, GraphEntityDto } from '@plaudern/contracts';
import { ENTITY_TYPE_HEX, RELATION_TYPE_LABEL } from '../../lib/entityLabels';
import {
  DEFAULT_SIM_PARAMS,
  SIM_ALPHA_MIN,
  SIM_ALPHA_REHEAT,
  type SimLink,
  type SimNode,
  tickSimulation,
} from './forceSimulation';
import { edgeKey } from './graphModel';

interface Transform {
  x: number;
  y: number;
  k: number;
}

interface GraphCanvasProps {
  nodes: GraphEntityDto[];
  edges: EntityRelationEdgeDto[];
  /** Nodes in the connect-mode selection (drawn with a selection ring). */
  selectedIds: Set<string>;
  /** The tapped node whose detail sheet is open (drawn emphasised). */
  focusId: string | null;
  /** Nodes that lie on a discovered connect path (drawn highlighted). */
  highlightedNodeIds: Set<string>;
  /** Edge keys on a discovered connect path (drawn highlighted). */
  highlightedEdgeKeys: Set<string>;
  /** Entity ids whose neighbourhood is already loaded (no "+" affordance). */
  expandedIds: Set<string>;
  onTapNode: (id: string) => void;
  onTapBackground: () => void;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 3.5;
const TAP_MOVE_TOLERANCE = 6; // px of screen movement still counted as a tap
const NODE_BASE_RADIUS = 13;

/**
 * A pan/zoom/tap SVG canvas driven by the hand-rolled force layout. It owns
 * node *positions* (preserved across prop changes, new nodes seeded near their
 * neighbours, then the layout reheats) while the parent owns which nodes/edges
 * exist and all selection state. Every interaction is pointer-based — pinch to
 * zoom, one-finger drag to pan, drag a node to reposition, tap to select — so
 * it works on an iOS PWA with no hover.
 */
export function GraphCanvas({
  nodes,
  edges,
  selectedIds,
  focusId,
  highlightedNodeIds,
  highlightedEdgeKeys,
  expandedIds,
  onTapNode,
  onTapBackground,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const posRef = useRef<Map<string, SimNode>>(new Map());
  const alphaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const sizeRef = useRef({ w: 320, h: 480 });
  const didCenterRef = useRef(false);

  // A monotonic counter bumped per animation frame; reading it in render is how
  // the mutable position map gets flushed to the DOM without cloning it.
  const [, setFrame] = useState(0);
  const [transform, setTransform] = useState<Transform>({ x: 160, y: 240, k: 1 });
  const transformRef = useRef(transform);
  transformRef.current = transform;

  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of edges) {
      map.set(e.sourceEntityId, (map.get(e.sourceEntityId) ?? 0) + 1);
      map.set(e.targetEntityId, (map.get(e.targetEntityId) ?? 0) + 1);
    }
    return map;
  }, [edges]);

  const links = useMemo<SimLink[]>(
    () => edges.map((e) => ({ source: e.sourceEntityId, target: e.targetEntityId })),
    [edges],
  );
  // The rAF loop reads links through a ref so an already-running loop picks up
  // newly expanded edges immediately instead of keeping a stale closure.
  const linksRef = useRef(links);
  linksRef.current = links;

  const simParams = useMemo(
    () => ({ ...DEFAULT_SIM_PARAMS, center: { x: 0, y: 0 } }),
    [],
  );

  const ensureRunning = useCallback(() => {
    if (rafRef.current != null) return;
    const loop = () => {
      const list = [...posRef.current.values()];
      alphaRef.current = tickSimulation(list, linksRef.current, simParams, alphaRef.current);
      setFrame((f) => (f + 1) % 1_000_000);
      if (alphaRef.current > SIM_ALPHA_MIN) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(loop);
  }, [simParams]);

  // Signature of the previous node/edge SET — the parent recomputes its arrays
  // on every filter/selection change, so identity alone must never reheat a
  // settled layout (tapping a node or dragging the confidence slider would
  // violently re-lay-out otherwise).
  const structureSigRef = useRef('');

  // Reconcile positions whenever the node set changes: keep placed nodes, seed
  // newcomers near an already-placed neighbour (falling back to the centre),
  // drop departed nodes, then reheat so the layout re-settles.
  useEffect(() => {
    const pos = posRef.current;
    const wanted = new Set(nodes.map((n) => n.id));
    for (const id of [...pos.keys()]) if (!wanted.has(id)) pos.delete(id);

    const neighbours = new Map<string, string[]>();
    const addNeighbour = (from: string, to: string) => {
      const list = neighbours.get(from);
      if (list) list.push(to);
      else neighbours.set(from, [to]);
    };
    for (const e of edges) {
      addNeighbour(e.sourceEntityId, e.targetEntityId);
      addNeighbour(e.targetEntityId, e.sourceEntityId);
    }

    for (const node of nodes) {
      if (pos.has(node.id)) continue;
      const anchor = (neighbours.get(node.id) ?? []).map((n) => pos.get(n)).find(Boolean);
      const angle = Math.random() * Math.PI * 2;
      const spread = anchor ? 110 : 220;
      pos.set(node.id, {
        id: node.id,
        x: (anchor?.x ?? 0) + Math.cos(angle) * (spread * 0.5 + spread * 0.5 * Math.random()),
        y: (anchor?.y ?? 0) + Math.sin(angle) * (spread * 0.5 + spread * 0.5 * Math.random()),
        vx: 0,
        vy: 0,
      });
    }

    // Only an actual set change (nodes/edges added or removed) reheats the
    // layout; identity-only prop changes leave a settled simulation alone.
    const signature = `${[...wanted].sort().join('|')}#${edges
      .map((e) => `${e.sourceEntityId}:${e.targetEntityId}:${e.relationType}`)
      .sort()
      .join('|')}`;
    const structureChanged = signature !== structureSigRef.current;
    structureSigRef.current = signature;

    if (structureChanged && pos.size > 0) {
      alphaRef.current = SIM_ALPHA_REHEAT;
      ensureRunning();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // Measure the canvas and, once, centre the viewport on the layout origin.
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const rect = svg.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
      if (!didCenterRef.current && rect.width > 0) {
        didCenterRef.current = true;
        setTransform({ x: rect.width / 2, y: rect.height / 2, k: 1 });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // ---- pointer gestures ---------------------------------------------------
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinchStart = useRef<{ dist: number; mid: { x: number; y: number }; t: Transform } | null>(
    null,
  );
  const nodeDrag = useRef<
    { id: string; pointerId: number; startX: number; startY: number; moved: boolean } | null
  >(null);

  const svgPoint = (clientX: number, clientY: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  };

  const toGraph = (screenX: number, screenY: number) => {
    const t = transformRef.current;
    return { x: (screenX - t.x) / t.k, y: (screenY - t.y) / t.k };
  };

  const onBackgroundPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (nodeDrag.current) return; // a node claimed this gesture
    const p = svgPoint(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      panStart.current = { x: p.x, y: p.y, tx: transformRef.current.x, ty: transformRef.current.y };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        t: { ...transformRef.current },
      };
      panStart.current = null;
    }
  };

  const onBackgroundPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = svgPoint(e.clientX, e.clientY);
    pointers.current.set(e.pointerId, p);

    if (pointers.current.size >= 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const start = pinchStart.current;
      const k = clamp(start.t.k * (dist / start.dist), MIN_SCALE, MAX_SCALE);
      // Keep the graph point under the initial midpoint anchored as we scale.
      const gx = (start.mid.x - start.t.x) / start.t.k;
      const gy = (start.mid.y - start.t.y) / start.t.k;
      setTransform({ x: start.mid.x - gx * k, y: start.mid.y - gy * k, k });
    } else if (panStart.current) {
      const s = panStart.current;
      setTransform((t) => ({ ...t, x: s.tx + (p.x - s.x), y: s.ty + (p.y - s.y) }));
    }
  };

  const endBackgroundPointer = (e: React.PointerEvent<SVGSVGElement>) => {
    const hadTwo = pointers.current.size >= 2;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) {
      // A clean tap on empty canvas dismisses any open selection.
      if (!hadTwo && panStart.current) {
        const moved =
          Math.hypot(
            e.clientX - (svgRef.current?.getBoundingClientRect().left ?? 0) - panStart.current.x,
            e.clientY - (svgRef.current?.getBoundingClientRect().top ?? 0) - panStart.current.y,
          ) > TAP_MOVE_TOLERANCE;
        if (!moved) onTapBackground();
      }
      panStart.current = null;
    } else if (pointers.current.size === 1) {
      const [only] = [...pointers.current.entries()];
      panStart.current = {
        x: only[1].x,
        y: only[1].y,
        tx: transformRef.current.x,
        ty: transformRef.current.y,
      };
    }
  };

  const makeNodeHandlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      nodeDrag.current = { id, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false };
    },
    onPointerMove: (e: React.PointerEvent) => {
      const drag = nodeDrag.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (
        !drag.moved &&
        Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > TAP_MOVE_TOLERANCE
      ) {
        drag.moved = true;
      }
      if (!drag.moved) return;
      const p = svgPoint(e.clientX, e.clientY);
      const g = toGraph(p.x, p.y);
      const node = posRef.current.get(id);
      if (node) {
        node.fx = g.x;
        node.fy = g.y;
        node.x = g.x;
        node.y = g.y;
      }
      alphaRef.current = Math.max(alphaRef.current, 0.3);
      ensureRunning();
    },
    onPointerUp: (e: React.PointerEvent) => {
      const drag = nodeDrag.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      const node = posRef.current.get(id);
      if (node) {
        node.fx = null;
        node.fy = null;
      }
      if (!drag.moved) onTapNode(id);
      else {
        alphaRef.current = Math.max(alphaRef.current, 0.2);
        ensureRunning();
      }
      nodeDrag.current = null;
    },
  });

  // ---- render -------------------------------------------------------------
  const pos = posRef.current;
  const showEdgeLabels = transform.k >= 1.15;

  return (
    <svg
      ref={svgRef}
      className="h-full w-full touch-none select-none"
      style={{ touchAction: 'none' }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={onBackgroundPointerMove}
      onPointerUp={endBackgroundPointer}
      onPointerCancel={endBackgroundPointer}
    >
      <g transform={`translate(${transform.x} ${transform.y}) scale(${transform.k})`}>
        {edges.map((edge) => {
          const a = pos.get(edge.sourceEntityId);
          const b = pos.get(edge.targetEntityId);
          if (!a || !b) return null;
          const key = edgeKey(edge);
          const highlighted = highlightedEdgeKeys.has(key);
          const cooccurrence = edge.origin === 'cooccurrence';
          const midX = (a.x + b.x) / 2;
          const midY = (a.y + b.y) / 2;
          return (
            <g key={key}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={highlighted ? '#f59e0b' : 'currentColor'}
                strokeOpacity={highlighted ? 0.95 : cooccurrence ? 0.18 : 0.35}
                strokeWidth={highlighted ? 3 : 1.2}
                strokeDasharray={cooccurrence ? '4 4' : undefined}
                className="text-default-400"
              />
              {(showEdgeLabels || highlighted) && (
                <text
                  x={midX}
                  y={midY}
                  textAnchor="middle"
                  dominantBaseline="central"
                  className="fill-default-500"
                  style={{ fontSize: 7, pointerEvents: 'none' }}
                >
                  {RELATION_TYPE_LABEL[edge.relationType]}
                </text>
              )}
            </g>
          );
        })}

        {nodes.map((node) => {
          const p = pos.get(node.id);
          if (!p) return null;
          const r = NODE_BASE_RADIUS + Math.min(8, (degree.get(node.id) ?? 0));
          const selected = selectedIds.has(node.id);
          const focused = focusId === node.id;
          const onPath = highlightedNodeIds.has(node.id);
          const dimmed =
            highlightedNodeIds.size > 0 && !onPath && !selected && !focused;
          const canExpand = !expandedIds.has(node.id);
          return (
            <g
              key={node.id}
              transform={`translate(${p.x} ${p.y})`}
              style={{ cursor: 'pointer', opacity: dimmed ? 0.3 : 1 }}
              {...makeNodeHandlers(node.id)}
            >
              {(selected || focused) && (
                <circle
                  r={r + 4}
                  fill="none"
                  stroke={selected ? '#2563eb' : '#f59e0b'}
                  strokeWidth={2.5}
                />
              )}
              <circle
                r={r}
                fill={ENTITY_TYPE_HEX[node.type]}
                stroke={onPath ? '#f59e0b' : 'rgba(255,255,255,0.85)'}
                strokeWidth={onPath ? 3 : 1.5}
              />
              {canExpand && (
                <text
                  x={r - 3}
                  y={-r + 5}
                  textAnchor="middle"
                  dominantBaseline="central"
                  style={{ fontSize: 11, fontWeight: 700, pointerEvents: 'none' }}
                  fill="rgba(255,255,255,0.9)"
                >
                  +
                </text>
              )}
              <text
                y={r + 9}
                textAnchor="middle"
                dominantBaseline="central"
                // Halo = the theme's background colour so labels stay legible
                // over edges in BOTH themes (white glow light, black glow dark).
                className="fill-foreground stroke-background"
                style={{ fontSize: 9, pointerEvents: 'none', paintOrder: 'stroke' }}
                strokeWidth={2.5}
                strokeOpacity={0.8}
              >
                {truncate(node.canonicalName)}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function truncate(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

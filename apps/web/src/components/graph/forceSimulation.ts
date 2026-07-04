/**
 * A tiny hand-rolled force-directed layout — deliberately dependency-free
 * (d3-force et al. are heavier than this whole view needs) and tuned to
 * *settle and stop*: alpha decays every tick and the animation loop halts once
 * it drops below a threshold, so a backgrounded PWA never burns battery
 * spinning an idle simulation. Node count is capped by the caller, keeping the
 * O(n²) repulsion pass cheap on an iPhone.
 */

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned coordinates while the user drags a node; null/undefined = free. */
  fx?: number | null;
  fy?: number | null;
}

export interface SimLink {
  source: string;
  target: string;
}

export interface SimParams {
  /** Repulsion strength between every pair of nodes (Coulomb-ish). */
  charge: number;
  /** Rest length of a link spring. */
  linkDistance: number;
  /** Spring stiffness in [0, 1]. */
  linkStrength: number;
  /** Pull toward the layout centre, per tick. */
  centerStrength: number;
  /** Velocity damping in [0, 1] applied each tick. */
  friction: number;
  center: { x: number; y: number };
}

export const DEFAULT_SIM_PARAMS: Omit<SimParams, 'center'> = {
  charge: 16000,
  linkDistance: 120,
  linkStrength: 0.08,
  centerStrength: 0.012,
  friction: 0.86,
};

/** Below this alpha the layout is considered settled and the loop stops. */
export const SIM_ALPHA_MIN = 0.008;
/** Alpha value a reheat resets to (1 = fully hot). */
export const SIM_ALPHA_REHEAT = 1;
const ALPHA_DECAY = 0.028;

/**
 * Advance the simulation one tick in place and return the next alpha. Mutates
 * each node's `x/y/vx/vy` (pinned nodes are snapped to `fx/fy`).
 */
export function tickSimulation(
  nodes: SimNode[],
  links: SimLink[],
  params: SimParams,
  alpha: number,
): number {
  const { charge, linkDistance, linkStrength, centerStrength, friction, center } = params;
  const byId = new Map<string, SimNode>();
  for (const n of nodes) byId.set(n.id, n);

  // Pairwise repulsion — n is capped small enough that O(n²) is fine.
  for (let i = 0; i < nodes.length; i += 1) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j += 1) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 0.01) {
        // Coincident nodes: nudge apart deterministically so they separate.
        dx = (i - j) * 0.5 + 0.5;
        dy = (j - i) * 0.5 + 0.5;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const force = (charge * alpha) / distSq;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // Link springs pull connected nodes toward the rest length.
  for (const link of links) {
    const a = byId.get(link.source);
    const b = byId.get(link.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const displacement = (dist - linkDistance) * linkStrength * alpha;
    const fx = (dx / dist) * displacement;
    const fy = (dy / dist) * displacement;
    a.vx += fx;
    a.vy += fy;
    b.vx -= fx;
    b.vy -= fy;
  }

  // Gentle centring keeps disconnected components from drifting off-canvas.
  for (const n of nodes) {
    n.vx += (center.x - n.x) * centerStrength * alpha;
    n.vy += (center.y - n.y) * centerStrength * alpha;
  }

  // Integrate + damp; pinned nodes ignore velocity and stick to fx/fy.
  for (const n of nodes) {
    if (n.fx != null && n.fy != null) {
      n.x = n.fx;
      n.y = n.fy;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= friction;
    n.vy *= friction;
    n.x += n.vx;
    n.y += n.vy;
  }

  return alpha + (SIM_ALPHA_MIN - alpha) * ALPHA_DECAY;
}

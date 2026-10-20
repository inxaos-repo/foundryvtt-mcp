/**
 * Pure geometry helpers for the GM toolkit: wall/door classification and a
 * movement-blocking check (segment vs wall intersection). This approximates
 * Foundry's movement collision — it does not model one-way walls' direction,
 * terrain walls or regions, and is not a line-of-sight solver.
 */

export interface WallLike {
  _id: string;
  c: number[];
  door?: number;
  ds?: number;
  move?: number;
  sight?: number;
  light?: number;
  sound?: number;
  dir?: number;
}

/** Foundry CONST.WALL_DOOR_TYPES */
export const DOOR_TYPES: Record<number, string> = { 0: 'none', 1: 'door', 2: 'secret' };
/** Foundry CONST.WALL_DOOR_STATES */
export const DOOR_STATES: Record<number, 'closed' | 'open' | 'locked'> = {
  0: 'closed',
  1: 'open',
  2: 'locked',
};
export const DOOR_STATE_VALUES: Record<'closed' | 'open' | 'locked', number> = {
  closed: 0,
  open: 1,
  locked: 2,
};

export function isDoor(w: WallLike): boolean {
  return (w.door ?? 0) > 0;
}

export function doorState(w: WallLike): 'closed' | 'open' | 'locked' {
  return DOOR_STATES[w.ds ?? 0] ?? 'closed';
}

/** Does this wall stop token movement right now? */
export function blocksMovement(w: WallLike): boolean {
  if ((w.move ?? 20) === 0) {
    return false;
  }
  if (isDoor(w) && (w.ds ?? 0) === 1) {
    return false;
  }
  return true;
}

export interface Point {
  x: number;
  y: number;
}

/** Proper intersection of segments AB and CD (touching endpoints count). */
export function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point): number => {
    const v = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    if (Math.abs(v) < 1e-9) {
      return 0;
    }
    return v > 0 ? 1 : 2;
  };
  const onSeg = (p: Point, q: Point, r: Point): boolean =>
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  if (o1 === 0 && onSeg(a, c, b)) {
    return true;
  }
  if (o2 === 0 && onSeg(a, d, b)) {
    return true;
  }
  if (o3 === 0 && onSeg(c, a, d)) {
    return true;
  }
  if (o4 === 0 && onSeg(c, b, d)) {
    return true;
  }
  return false;
}

/** Walls that block straight-line movement between two points (empty when clear). */
export function findBlockingWalls(walls: WallLike[], from: Point, to: Point): WallLike[] {
  return walls.filter((w) => {
    if (!Array.isArray(w.c) || w.c.length < 4 || !blocksMovement(w)) {
      return false;
    }
    const [x1, y1, x2, y2] = w.c as [number, number, number, number];
    return segmentsIntersect(from, to, { x: x1, y: y1 }, { x: x2, y: y2 });
  });
}

export function wallMidpoint(w: WallLike): Point {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = w.c;
  return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
}

export interface GridPathOptions {
  /** Grid square size in pixels. */
  size: number;
  /** Search area in pixels; nodes outside it are not explored. */
  bounds?: { x: number; y: number; width: number; height: number } | undefined;
  /** Upper bound on explored nodes, to cap the cost on large maps. */
  maxNodes?: number;
}

export interface GridPath {
  /** Centre points from start to goal, collinear runs collapsed. */
  points: Point[];
  /** Number of grid steps taken (diagonals count as one). */
  steps: number;
}

/**
 * Shortest route between two centre points through the grid, moving one
 * square at a time (8 directions) and never crossing a wall that currently
 * blocks movement (see {@link blocksMovement}; closed and locked doors block,
 * open doors do not). Diagonal steps must also clear both orthogonal steps so
 * the route cannot slip through a wall corner. Returns `null` when no route
 * exists within the search limits.
 *
 * This is an approximation of Foundry's own movement checks: it ignores
 * one-way (directional) walls, regions and terrain, and treats the token as a
 * point at its centre.
 */
export function findGridPath(
  walls: WallLike[],
  from: Point,
  to: Point,
  opts: GridPathOptions,
): GridPath | null {
  const size = opts.size;
  const solid = walls
    .filter((w) => Array.isArray(w.c) && w.c.length >= 4 && blocksMovement(w))
    .map((w) => {
      const [x1, y1, x2, y2] = w.c as [number, number, number, number];
      return {
        a: { x: x1, y: y1 },
        b: { x: x2, y: y2 },
        minX: Math.min(x1, x2),
        maxX: Math.max(x1, x2),
        minY: Math.min(y1, y2),
        maxY: Math.max(y1, y2),
      };
    });
  const clear = (p: Point, q: Point): boolean => {
    const minX = Math.min(p.x, q.x);
    const maxX = Math.max(p.x, q.x);
    const minY = Math.min(p.y, q.y);
    const maxY = Math.max(p.y, q.y);
    for (const s of solid) {
      if (s.maxX < minX || s.minX > maxX || s.maxY < minY || s.minY > maxY) {
        continue;
      }
      if (segmentsIntersect(p, q, s.a, s.b)) {
        return false;
      }
    }
    return true;
  };
  if (clear(from, to)) {
    return {
      points: [from, to],
      steps: Math.max(
        1,
        Math.round(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) / size),
      ),
    };
  }
  // Lattice anchored on the start centre; the goal joins it from any node
  // within one square that has a clear line to it.
  const key = (i: number, j: number) => `${i},${j}`;
  const at = (i: number, j: number): Point => ({ x: from.x + i * size, y: from.y + j * size });
  const b = opts.bounds;
  const inBounds = (p: Point) =>
    !b || (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
  const maxNodes = opts.maxNodes ?? 40000;
  const prev = new Map<string, string | null>([[key(0, 0), null]]);
  const queue: Array<[number, number]> = [[0, 0]];
  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];
  let goalFrom: string | null = null;
  for (let head = 0; head < queue.length && prev.size <= maxNodes; head++) {
    const [i, j] = queue[head] as [number, number];
    const p = at(i, j);
    if (Math.abs(p.x - to.x) <= size && Math.abs(p.y - to.y) <= size && clear(p, to)) {
      goalFrom = key(i, j);
      break;
    }
    for (const [di, dj] of dirs) {
      const k = key(i + di, j + dj);
      if (prev.has(k)) {
        continue;
      }
      const q = at(i + di, j + dj);
      if (!inBounds(q) || !clear(p, q)) {
        continue;
      }
      if (di && dj && (!clear(p, at(i + di, j)) || !clear(p, at(i, j + dj)))) {
        continue;
      }
      prev.set(k, key(i, j));
      queue.push([i + di, j + dj]);
    }
  }
  if (goalFrom === null) {
    return null;
  }
  const cells: Point[] = [];
  for (let k: string | null = goalFrom; k !== null; k = prev.get(k) ?? null) {
    const [i = 0, j = 0] = k.split(',').map(Number);
    cells.unshift(at(i, j));
  }
  const last = cells[cells.length - 1] ?? from;
  const steps = cells.length - 1 + (last.x === to.x && last.y === to.y ? 0 : 1);
  const raw = [...cells, to];
  const points: Point[] = [from];
  for (let n = 1; n < raw.length - 1; n++) {
    const a = points[points.length - 1] as Point;
    const c = raw[n + 1] as Point;
    const m = raw[n] as Point;
    const collinear = (m.x - a.x) * (c.y - a.y) - (m.y - a.y) * (c.x - a.x) === 0;
    if (!collinear) {
      points.push(m);
    }
  }
  points.push(to);
  return { points, steps };
}

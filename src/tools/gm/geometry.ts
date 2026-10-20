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

/** First wall (in list order) blocking straight movement from → to, or null. */
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

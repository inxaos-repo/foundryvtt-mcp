/**
 * Token movement payloads.
 *
 * Since Foundry v13 a token's x/y/elevation change is a "movement": the
 * originating client attaches an `_movement` record to the update operation
 * and sends every position field with `diff: false`. Other connected clients
 * rely on that record to animate and commit the new position. An update that
 * changes x/y without it is stored by the server (and visible after a reload)
 * but is not applied on already-connected clients, so players see no change
 * until they refresh. These helpers build the same payload a browser client
 * sends for an API-initiated move.
 */

import { randomBytes } from 'node:crypto';

/** Position fields that make a Token update a movement. */
export const MOVEMENT_FIELDS = [
  'x',
  'y',
  'elevation',
  'width',
  'height',
  'shape',
  'level',
] as const;

type Obj = Record<string, unknown>;

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** A random 16-character Foundry document id. */
export function randomId(length = 16): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ID_CHARS.charAt((bytes[i] ?? 0) % ID_CHARS.length);
  }
  return out;
}

/** True when the flat or nested update changes a position field. */
export function isMovementUpdate(update: Obj): boolean {
  return MOVEMENT_FIELDS.some((f) => f in update);
}

interface Position {
  x: number;
  y: number;
  elevation: number;
  width: number;
  height: number;
  depth?: number;
  shape?: number;
  level?: string;
}

function position(src: Obj, fallback?: Position): Position {
  const pick = (k: string, d: unknown): unknown => (src[k] !== undefined ? src[k] : d);
  const p: Position = {
    x: Number(pick('x', fallback?.x ?? 0)),
    y: Number(pick('y', fallback?.y ?? 0)),
    elevation: Number(pick('elevation', fallback?.elevation ?? 0)),
    width: Number(pick('width', fallback?.width ?? 1)),
    height: Number(pick('height', fallback?.height ?? 1)),
  };
  const depth = pick('depth', fallback?.depth);
  if (depth !== undefined) {
    p.depth = Number(depth);
  }
  const shape = pick('shape', fallback?.shape);
  if (shape !== undefined) {
    p.shape = Number(shape);
  }
  const level = pick('level', fallback?.level);
  if (level !== undefined && level !== null) {
    p.level = String(level);
  }
  return p;
}

function emptyPath(): Obj {
  return { waypoints: [], distance: 0, cost: 0, spaces: 0, diagonals: 0 };
}

/**
 * Build the update entry and `_movement` record for moving `token` according
 * to `update` (which must contain `_id` and at least one position field).
 *
 * @param token  Current token source data.
 * @param update Requested changes.
 * @param userId Id of the user performing the move.
 * @param opts.gridSize Scene grid size in pixels (for the ruler total).
 * @param opts.gridDistance Scene distance units per grid square.
 * @param opts.waypoints Optional intermediate top-left positions (pixels) the
 *                       token passes through, e.g. a path routed around walls.
 */
export function buildTokenMovement(
  token: Obj,
  update: Obj,
  userId: string | undefined,
  opts: {
    gridSize?: number;
    gridDistance?: number;
    waypoints?: Array<{ x: number; y: number }>;
  } = {},
): { update: Obj; movement: Obj } {
  const waypoints = opts.waypoints ?? [];
  const gridDistance = opts.gridDistance ?? 1;
  const size = opts.gridSize ?? 0;
  const origin = position(token);
  const destination = position(update, origin);
  const movementId = randomId();
  const waypoint = (p: Position, extra: Obj = {}): Obj => ({
    ...p,
    action: 'walk',
    terrain: null,
    snapped: false,
    explicit: false,
    checkpoint: true,
    intermediate: false,
    userId: userId ?? null,
    movementId,
    subpathId: movementId,
    cost: 0,
    ...extra,
  });
  const passed = [
    // Route corners are marked explicit: Foundry clients skip waypoints that are
    // intermediate && !explicit when animating, which would make the token
    // slide in a straight line (through walls) instead of walking the route.
    ...waypoints.map((w) =>
      waypoint({ ...destination, x: w.x, y: w.y }, { intermediate: true, explicit: true }),
    ),
    waypoint(destination),
  ];
  let spaces = 0;
  let prev = origin;
  for (const w of passed) {
    const step = size
      ? Math.max(Math.abs(Number(w.x) - prev.x), Math.abs(Number(w.y) - prev.y)) / size
      : 0;
    spaces += Math.round(step);
    prev = { ...prev, x: Number(w.x), y: Number(w.y) };
  }
  const movement: Obj = {
    id: movementId,
    subpathId: movementId,
    chain: [],
    origin,
    destination,
    passed: {
      waypoints: passed,
      distance: spaces * gridDistance,
      cost: 0,
      spaces,
      diagonals: 0,
    },
    pending: emptyPath(),
    history: {
      recorded: emptyPath(),
      unrecorded: { ...emptyPath(), waypoints: [waypoint(origin)] },
      distance: 0,
      cost: 0,
      spaces: 0,
      diagonals: 0,
    },
    split: false,
    constrained: false,
    recorded: false,
    method: 'api',
    terrainOptions: {},
    constrainOptions: {},
    measureOptions: {},
    autoRotate: false,
    showRuler: false,
  };
  return { update: { ...update, ...destination }, movement };
}

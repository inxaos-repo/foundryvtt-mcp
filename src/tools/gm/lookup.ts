/**
 * Read-only token lookups for running encounters: who is near whom, which
 * token belongs to an actor, and a compact "whose turn is it and what can they
 * see" summary.
 *
 * Distances are in grid squares, edge to edge (adjacent tokens are 1 square
 * apart), measured with the simple "diagonals cost 1" rule; scene units are
 * squares × grid distance. Line of sight is a centre-to-centre wall test, not
 * Foundry's vision polygon: it ignores lighting, darkvision, one-way walls and
 * token vision settings.
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { WorldCombat } from '../../foundry/types.js';
import { getCurrentCombatant } from '../handlers/combat-order.js';
import {
  blocksMovement,
  isDoor,
  type Point,
  segmentsIntersect,
  type WallLike,
} from './geometry.js';
import {
  type ActorObj,
  bool,
  embedded,
  GmToolError,
  getActor,
  getPath,
  getScene,
  locateToken,
  num,
  type Obj,
  ok,
  type SceneObj,
  str,
  world,
} from './helpers.js';
import type { GmToolSpec } from './tool-spec.js';

type TokenObj = Obj & { _id: string; name?: string };

/** Foundry CONST.TOKEN_DISPOSITIONS */
const DISPOSITIONS: Record<number, string> = {
  [-2]: 'secret',
  [-1]: 'hostile',
  0: 'neutral',
  1: 'friendly',
};

const HP_PATHS = ['system.hp', 'system.attributes.hp'];

export function gridOf(scene: Obj): { size: number; distance: number; units: string } {
  const grid = scene.grid as Obj | number | undefined;
  const size = Number((typeof grid === 'object' ? grid?.size : grid) ?? 100) || 100;
  const distance = Number(typeof grid === 'object' ? grid?.distance : scene.gridDistance) || 1;
  const units = String((typeof grid === 'object' ? grid?.units : scene.gridUnits) ?? '');
  return { size, distance, units };
}

function dims(t: Obj): { w: number; h: number } {
  return { w: Number(t.width ?? 1) || 1, h: Number(t.height ?? 1) || 1 };
}

export function tokenCentre(t: Obj, size: number): Point {
  const { w, h } = dims(t);
  return { x: Number(t.x ?? 0) + (w * size) / 2, y: Number(t.y ?? 0) + (h * size) / 2 };
}

/** Edge-to-edge distance in squares (adjacent = 1). */
export function squaresBetween(a: Obj, b: Obj, size: number): number {
  const ca = tokenCentre(a, size);
  const cb = tokenCentre(b, size);
  const da = dims(a);
  const db = dims(b);
  const ax = Math.max(0, Math.abs(ca.x - cb.x) - ((da.w + db.w - 2) / 2) * size);
  const ay = Math.max(0, Math.abs(ca.y - cb.y) - ((da.h + db.h - 2) / 2) * size);
  return Math.round(Math.max(ax, ay) / size);
}

/** Does this wall block sight right now? (open doors and sight-less walls don't) */
export function blocksSight(w: WallLike): boolean {
  if ((w.sight ?? 20) === 0) {
    return false;
  }
  return !(isDoor(w) && (w.ds ?? 0) === 1);
}

/**
 * Centre-to-centre line of sight. Limited ("terrain") sight walls (10) only
 * block when two or more are crossed, matching Foundry's rule.
 */
export function hasLineOfSight(walls: WallLike[], from: Point, to: Point): boolean {
  let limited = 0;
  for (const w of walls) {
    if (!Array.isArray(w.c) || w.c.length < 4 || !blocksSight(w)) {
      continue;
    }
    const [x1, y1, x2, y2] = w.c as [number, number, number, number];
    if (!segmentsIntersect(from, to, { x: x1, y: y1 }, { x: x2, y: y2 })) {
      continue;
    }
    if ((w.sight ?? 20) === 10) {
      limited++;
      if (limited >= 2) {
        return false;
      }
    } else {
      return false;
    }
  }
  return true;
}

function tokenActor(client: FoundryClient, t: Obj): ActorObj | undefined {
  if (!t.actorId) {
    return undefined;
  }
  try {
    return getActor(client, String(t.actorId));
  } catch {
    return undefined;
  }
}

/** HP {value,max} honouring an unlinked token's delta. */
export function tokenHp(
  t: Obj,
  actor: ActorObj | undefined,
): { value: number; max?: number } | undefined {
  const delta = (!t.actorLink ? (t.delta ?? {}) : {}) as Obj;
  for (const p of HP_PATHS) {
    const v = getPath(delta, `${p}.value`) ?? getPath(actor, `${p}.value`);
    if (typeof v === 'number') {
      const m = getPath(delta, `${p}.max`) ?? getPath(actor, `${p}.max`);
      return typeof m === 'number' ? { value: v, max: m } : { value: v };
    }
  }
  return undefined;
}

/** Status ids from the actor's effects and (unlinked) the token delta's effects. */
export function tokenConditions(t: Obj, actor: ActorObj | undefined): string[] {
  const delta = (!t.actorLink ? (t.delta ?? {}) : {}) as Obj;
  const effects = [
    ...(actor ? embedded(actor, 'effects') : []),
    ...((delta.effects as Obj[] | undefined) ?? []),
  ].filter((e) => !e.disabled);
  return [...new Set(effects.flatMap((e) => (e.statuses as string[] | undefined) ?? []))];
}

interface TokenSummary {
  tokenId: string;
  name: string;
  actorId?: string;
  disposition: string;
  hidden: boolean;
  squares?: number;
  distance?: number;
  hp?: { value: number; max?: number };
  conditions: string[];
  lineOfSight?: boolean;
}

function summarise(
  client: FoundryClient,
  t: TokenObj,
  extra: Partial<TokenSummary> = {},
): TokenSummary {
  const actor = tokenActor(client, t);
  const out: TokenSummary = {
    tokenId: t._id,
    name: String(t.name ?? actor?.name ?? t._id),
    disposition: DISPOSITIONS[Number(t.disposition ?? 0)] ?? String(t.disposition),
    hidden: Boolean(t.hidden),
    conditions: tokenConditions(t, actor),
    ...extra,
  };
  if (t.actorId) {
    out.actorId = String(t.actorId);
  }
  const hp = tokenHp(t, actor);
  if (hp) {
    out.hp = hp;
  }
  return out;
}

function describe(s: TokenSummary, units: string): string {
  const bits = [
    s.squares !== undefined
      ? `${s.squares} sq${s.distance !== undefined ? ` (${s.distance}${units ? ` ${units}` : ''})` : ''}`
      : '',
    s.disposition,
    s.hp ? `HP ${s.hp.value}${s.hp.max !== undefined ? `/${s.hp.max}` : ''}` : '',
    s.conditions.length ? s.conditions.join(',') : '',
    s.lineOfSight === undefined ? '' : s.lineOfSight ? 'in sight' : 'no LoS',
    s.hidden ? 'hidden' : '',
  ].filter(Boolean);
  return `${s.name} [${s.tokenId}] — ${bits.join(', ')}`;
}

interface NearOptions {
  radius: number;
  disposition?: string;
  includeHidden: boolean;
}

function nearby(
  client: FoundryClient,
  scene: SceneObj,
  origin: Obj,
  opts: NearOptions,
  excludeId?: string,
): TokenSummary[] {
  const { size, distance } = gridOf(scene);
  const walls = embedded(scene, 'walls') as unknown as WallLike[];
  const from = tokenCentre(origin, size);
  const withLos = excludeId !== undefined;
  return (embedded(scene, 'tokens') as TokenObj[])
    .filter((t) => t._id !== excludeId)
    .filter((t) => opts.includeHidden || !t.hidden)
    .map((t) => ({ t, squares: squaresBetween(origin, t, size) }))
    .filter(({ squares }) => squares <= opts.radius)
    .map(({ t, squares }) =>
      summarise(client, t, {
        squares,
        distance: squares * distance,
        ...(withLos ? { lineOfSight: hasLineOfSight(walls, from, tokenCentre(t, size)) } : {}),
      }),
    )
    .filter((s) => !opts.disposition || s.disposition === opts.disposition)
    .sort((a, b) => (a.squares ?? 0) - (b.squares ?? 0) || a.name.localeCompare(b.name));
}

/**
 * Small ASCII map centred on `centre`. Walls on
 * a cell edge (one character between cells) are drawn as # (wall), + (closed door), L (locked door); open
 * doors are blank. Tokens are @ (centre) or a letter from the legend.
 */
export function asciiMap(
  scene: SceneObj,
  centre: Obj,
  others: TokenSummary[],
  radius: number,
): { map: string; legend: Record<string, string> } {
  const { size } = gridOf(scene);
  const walls = (embedded(scene, 'walls') as unknown as WallLike[]).filter(
    (w) => Array.isArray(w.c) && w.c.length >= 4 && (blocksMovement(w) || isDoor(w)),
  );
  const tokens = embedded(scene, 'tokens') as TokenObj[];
  const cx = Math.floor((Number(centre.x ?? 0) + size / 2) / size);
  const cy = Math.floor((Number(centre.y ?? 0) + size / 2) / size);
  const legend: Record<string, string> = { '@': String(centre.name ?? centre._id) };
  const marks = new Map<string, string>();
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let li = 0;
  for (const s of others) {
    const t = tokens.find((x) => x._id === s.tokenId);
    if (!t) {
      continue;
    }
    const ch = letters[li++] ?? '?';
    legend[ch] = `${s.name} [${s.tokenId}]`;
    const { w, h } = dims(t);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        marks.set(
          `${Math.floor(Number(t.x ?? 0) / size) + i},${Math.floor(Number(t.y ?? 0) / size) + j}`,
          ch,
        );
      }
    }
  }
  {
    const { w, h } = dims(centre);
    for (let i = 0; i < w; i++) {
      for (let j = 0; j < h; j++) {
        marks.set(
          `${Math.floor(Number(centre.x ?? 0) / size) + i},${Math.floor(Number(centre.y ?? 0) / size) + j}`,
          '@',
        );
      }
    }
  }
  const edge = (a: Point, b: Point): string => {
    for (const w of walls) {
      const [x1, y1, x2, y2] = w.c as [number, number, number, number];
      if (segmentsIntersect(a, b, { x: x1, y: y1 }, { x: x2, y: y2 })) {
        if (isDoor(w)) {
          const ds = w.ds ?? 0;
          if (ds === 1) {
            continue;
          }
          return ds === 2 ? 'L' : '+';
        }
        return '#';
      }
    }
    return ' ';
  };
  const centreOf = (gx: number, gy: number): Point => ({
    x: gx * size + size / 2,
    y: gy * size + size / 2,
  });
  const lines: string[] = [];
  for (let gy = cy - radius; gy <= cy + radius; gy++) {
    let row = '';
    let below = '';
    for (let gx = cx - radius; gx <= cx + radius; gx++) {
      row += marks.get(`${gx},${gy}`) ?? '.';
      below += gy < cy + radius ? edge(centreOf(gx, gy), centreOf(gx, gy + 1)) : '';
      if (gx < cx + radius) {
        row += edge(centreOf(gx, gy), centreOf(gx + 1, gy));
        below += ' ';
      }
    }
    lines.push(row.trimEnd());
    if (gy < cy + radius) {
      lines.push(below.trimEnd());
    }
  }
  return { map: lines.join('\n'), legend };
}

function nearOpts(args: Obj, dfltRadius: number): NearOptions {
  const disposition = str(args, 'disposition', false);
  if (disposition && !Object.values(DISPOSITIONS).includes(disposition)) {
    throw new GmToolError(`disposition must be one of ${Object.values(DISPOSITIONS).join(', ')}`);
  }
  const opts: NearOptions = {
    radius: num(args, 'radius', false) ?? dfltRadius,
    includeHidden: bool(args, 'includeHidden', true) ?? true,
  };
  if (disposition) {
    opts.disposition = disposition;
  }
  return opts;
}

const NEAR_PROPS = {
  radius: { type: 'number', description: 'Max distance in grid squares, edge to edge' },
  disposition: {
    type: 'string',
    enum: ['hostile', 'neutral', 'friendly', 'secret'],
    description: 'Only tokens with this disposition',
  },
  includeHidden: {
    type: 'boolean',
    description: 'Include GM-hidden tokens (default true; they are flagged)',
  },
};

export const lookupTools: GmToolSpec[] = [
  {
    name: 'tokens_near',
    description:
      'List tokens within a radius (grid squares, edge to edge; adjacent = 1) of a token or of a pixel point, nearest first, with distance, disposition, HP and conditions. When centred on a token, also a centre-to-centre line-of-sight check against sight-blocking walls (not Foundry vision: ignores light and token senses). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Centre token (id or name in sceneId)' },
        x: { type: 'number', description: 'Centre pixel x (instead of tokenId)' },
        y: { type: 'number', description: 'Centre pixel y (instead of tokenId)' },
        sceneId: { type: 'string', description: 'Default: the token’s scene, or the active scene' },
        ...NEAR_PROPS,
      },
    },
    async run(client, args) {
      const opts = nearOpts(args, 6);
      const tokenKey = str(args, 'tokenId', false);
      let scene: SceneObj;
      let origin: Obj;
      let label: string;
      if (tokenKey) {
        const loc = locateToken(client, tokenKey, str(args, 'sceneId', false));
        scene = loc.scene;
        origin = loc.token;
        label = String(loc.token.name ?? loc.token._id);
      } else {
        const x = num(args, 'x', false);
        const y = num(args, 'y', false);
        if (x === undefined || y === undefined) {
          throw new GmToolError('Pass tokenId, or x and y');
        }
        scene = getScene(client, str(args, 'sceneId', false));
        const { size } = gridOf(scene);
        // A 1×1 pseudo-token whose centre is the point.
        origin = { x: x - size / 2, y: y - size / 2, width: 1, height: 1 };
        label = `(${x},${y})`;
      }
      const { units } = gridOf(scene);
      const list = nearby(client, scene, origin, opts, tokenKey ? String(origin._id) : undefined);
      const text = list.length ? list.map((s) => `- ${describe(s, units)}`).join('\n') : '(none)';
      return ok(`📍 Within ${opts.radius} sq of ${label} in ${scene.name}:\n${text}`, {
        sceneId: scene._id,
        tokens: list,
      });
    },
  },
  {
    name: 'token_for_actor',
    description:
      'Find the token(s) that represent an actor (id or exact name), linked or unlinked, in one scene or every scene. Active scene first. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: 'Actor id or exact name' },
        sceneId: { type: 'string', description: 'Limit to one scene' },
      },
      required: ['actorId'],
    },
    async run(client, args) {
      const actor = getActor(client, str(args, 'actorId') as string);
      const sceneKey = str(args, 'sceneId', false);
      const scenes = sceneKey
        ? [getScene(client, sceneKey)]
        : [...(world(client).scenes as unknown as SceneObj[])].sort(
            (a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)),
          );
      const found = scenes.flatMap((scene) =>
        (embedded(scene, 'tokens') as TokenObj[])
          .filter((t) => t.actorId === actor._id)
          .map((t) => ({
            sceneId: scene._id,
            sceneName: scene.name,
            activeScene: Boolean(scene.active),
            linked: Boolean(t.actorLink),
            x: t.x,
            y: t.y,
            ...summarise(client, t),
          })),
      );
      if (!found.length) {
        return ok(`No token for ${actor.name} [${actor._id}]${sceneKey ? ' in that scene' : ''}.`, {
          actorId: actor._id,
          tokens: [],
        });
      }
      const text = found
        .map(
          (f) =>
            `- ${f.name} [${f.tokenId}] in ${f.sceneName}${f.activeScene ? ' (active)' : ''} at (${f.x},${f.y}), ${f.linked ? 'linked' : 'unlinked'}`,
        )
        .join('\n');
      return ok(`🎭 Tokens for ${actor.name}:\n${text}`, { actorId: actor._id, tokens: found });
    },
  },
  {
    name: 'turn_context',
    description:
      'Whose turn is it and what is around them: the current combatant (round, turn, HP, conditions) plus nearby tokens with distance (squares, edge to edge), disposition, HP, conditions and a centre-to-centre line-of-sight check against sight-blocking walls. map=true adds a small ASCII map (# wall, + closed door, L locked door). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        combatId: { type: 'string', description: 'Default: the active combat' },
        map: { type: 'boolean', description: 'Include an ASCII map around the combatant' },
        mapRadius: { type: 'number', description: 'Map half-width in squares (default 5, max 12)' },
        ...NEAR_PROPS,
      },
    },
    async run(client, args) {
      const combats = (world(client).combats ?? []) as unknown as WorldCombat[];
      const combatId = str(args, 'combatId', false);
      const combat = combatId
        ? combats.find((c) => c._id === combatId)
        : combats.find((c) => c.active);
      if (!combat) {
        throw new GmToolError(combatId ? `Combat ${combatId} not found` : 'No active combat');
      }
      const current = getCurrentCombatant(combat);
      if (!current) {
        return ok(`⚔️ Combat ${combat._id} has not started (no current combatant).`, {
          combatId: combat._id,
          round: combat.round,
        });
      }
      const cur = current as unknown as Obj;
      const sceneKey = String(cur.sceneId ?? (combat as unknown as Obj).scene ?? '');
      if (!cur.tokenId) {
        return ok(`⚔️ Round ${combat.round}: ${String(cur.name ?? cur.actorId)} (no token).`, {
          combatId: combat._id,
          round: combat.round,
          turn: combat.turn,
          combatant: { combatantId: cur._id, actorId: cur.actorId },
        });
      }
      const { token, scene } = locateToken(client, String(cur.tokenId), sceneKey || undefined);
      const opts = nearOpts(args, 12);
      const others = nearby(client, scene, token, opts, token._id);
      const me = summarise(client, token);
      const { units } = gridOf(scene);
      const lines = [
        `⚔️ Round ${combat.round}, turn ${Number(combat.turn ?? 0) + 1}: ${me.name} [${me.tokenId}] in ${scene.name} at (${token.x},${token.y})`,
        `   ${[me.disposition, me.hp ? `HP ${me.hp.value}${me.hp.max !== undefined ? `/${me.hp.max}` : ''}` : '', me.conditions.join(',')].filter(Boolean).join(', ')}`,
        `Nearby (≤${opts.radius} sq):`,
        ...(others.length ? others.map((s) => `- ${describe(s, units)}`) : ['(none)']),
      ];
      const data: Obj = {
        combatId: combat._id,
        round: combat.round,
        turn: combat.turn,
        sceneId: scene._id,
        combatant: {
          combatantId: cur._id,
          initiative: cur.initiative,
          x: token.x,
          y: token.y,
          ...me,
        },
        nearby: others,
      };
      if (bool(args, 'map', false)) {
        const r = Math.min(12, Math.max(1, num(args, 'mapRadius', false) ?? 5));
        const inMap = others.filter((s) => (s.squares ?? 0) <= r + 1);
        const m = asciiMap(scene, token, inMap, r);
        lines.push(
          '',
          '```',
          m.map,
          '```',
          Object.entries(m.legend)
            .map(([k, v]) => `${k}=${v}`)
            .join('  '),
        );
        data.map = m.map;
        data.legend = m.legend;
      }
      return ok(lines.join('\n'), data);
    },
  },
];

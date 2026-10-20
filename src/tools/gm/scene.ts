/**
 * Scene, token, door, fog and lighting tools.
 */

import type { FoundryClient } from '../../foundry/client.js';
import { sceneDarkness, sceneGlobalLight } from '../../foundry/client.js';
import {
  DOOR_STATE_VALUES,
  DOOR_TYPES,
  doorState,
  findBlockingWalls,
  findGridPath,
  isDoor,
  type WallLike,
  wallMidpoint,
} from './geometry.js';
import {
  bool,
  embedded,
  findByIdOrName,
  GmToolError,
  getActor,
  getScene,
  locateToken,
  num,
  type Obj,
  ok,
  type SceneObj,
  str,
  stripHtml,
  strList,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

/** Foundry's placeholder token image. */
export const DEFAULT_TOKEN_ICON = 'icons/svg/mystery-man.svg';

/**
 * Player-character tokens still using the placeholder icon. The icon is white
 * and disappears on light-coloured maps, so flag them with a tint suggestion.
 * A token counts as a player character when its actor is linked or is owned
 * by a non-GM user. Tokens that already have a non-white tint are skipped.
 */
export function defaultIconWarnings(scene: Obj, w: Obj): string[] {
  const users = embedded(w, 'users');
  const players = new Set(users.filter((u) => Number(u.role ?? 0) < 3).map((u) => String(u._id)));
  const actors = embedded(w, 'actors');
  const out: string[] = [];
  for (const t of embedded(scene, 'tokens')) {
    const src = String((t.texture as Obj | undefined)?.src ?? '');
    if (src !== DEFAULT_TOKEN_ICON) {
      continue;
    }
    const actor = actors.find((a) => a._id === t.actorId);
    const ownership = (actor?.ownership ?? {}) as Record<string, number>;
    const playerOwned = Object.entries(ownership).some(([id, lvl]) => players.has(id) && lvl >= 3);
    if (!t.actorLink && !playerOwned) {
      continue;
    }
    const tint = String((t.texture as Obj | undefined)?.tint ?? '').toLowerCase();
    if (tint && tint !== '#ffffff') {
      continue; // already tinted
    }
    out.push(
      `Token "${String(t.name)}" (${String(t._id)}) uses the default mystery-man icon, which is white and hard to see on light maps. Give it a portrait, or a strong tint such as texture.tint "#ff2020".`,
    );
  }
  return out;
}

/** Delay before re-sending pullToScene, in ms. */
export const PULL_RETRY_MS = 1500;

/** Read-backs after resetFog, and the pause between them. */
export const FOG_CONFIRM_POLLS = 6;
export const FOG_CONFIRM_INTERVAL_MS = 400;

/** How long to wait, after the last pull, for clients to report the new scene. */
export const PULL_CONFIRM_MS = 2500;

/**
 * Send pullToScene to each target, re-send once to clients that have not
 * reported the scene after {@link PULL_RETRY_MS} (a client still drawing the
 * previous canvas ignores a view request), then wait for confirmations.
 *
 * A client reports the scene it finished drawing through `userActivity`;
 * only users with an open client can confirm. A client that already shows
 * the scene does not redraw or report again, so its earlier report counts.
 */
async function pullAndConfirm(
  client: FoundryClient,
  sceneId: string,
  targets: Array<{ _id: string; name: string }>,
): Promise<{ confirmed: string[]; unconfirmed: string[]; offline: string[] }> {
  if (!targets.length) {
    return { confirmed: [], unconfirmed: [], offline: [] };
  }
  const active = new Set((world(client) as { activeUsers?: string[] }).activeUsers ?? []);
  const online = targets.filter((u) => active.has(u._id));
  const ids = online.map((u) => u._id);
  const pull = async (users: Array<{ _id: string }>) => {
    for (const u of users) {
      await client.gmEmit('pullToScene', sceneId, u._id, {});
    }
  };
  await pull(targets);
  let seen = await client.waitForViewedScene(ids, sceneId, PULL_RETRY_MS);
  const retry = online.filter((u) => !seen.includes(u._id));
  if (retry.length) {
    await pull(retry);
    seen = await client.waitForViewedScene(ids, sceneId, PULL_CONFIRM_MS);
  }
  return {
    confirmed: online.filter((u) => seen.includes(u._id)).map((u) => u.name),
    unconfirmed: online.filter((u) => !seen.includes(u._id)).map((u) => u.name),
    offline: targets.filter((u) => !active.has(u._id)).map((u) => u.name),
  };
}

function pullSummary(r: { confirmed: string[]; unconfirmed: string[]; offline: string[] }): string {
  const parts = [`${r.confirmed.length} confirmed on scene`];
  if (r.unconfirmed.length) {
    parts.push(`${r.unconfirmed.length} online but not confirmed (${r.unconfirmed.join(', ')})`);
  }
  if (r.offline.length) {
    parts.push(`${r.offline.length} offline`);
  }
  return parts.join('; ');
}

/**
 * Users to pull on activation. Online status in the cached world data can be
 * stale, and the server ignores users with no open sockets, so every non-GM
 * user is targeted.
 */
function pullTargets(
  client: Parameters<typeof world>[0],
  includeGMs: boolean,
): Array<{ _id: string; name: string }> {
  const users = (world(client).users ?? []) as Array<{
    _id: string;
    name: string;
    role?: number;
  }>;
  return users.filter((u) => includeGMs || (u.role ?? 0) < 3);
}

const sceneIdProp = {
  sceneId: { type: 'string', description: 'Scene id or name (default: the active scene)' },
};

/**
 * Token updates go through {@link FoundryClient.updateTokens} so that position
 * changes are sent as movements and render live for connected players.
 */
function tokenUpdate(
  client: FoundryClient,
  sceneId: string,
  updates: Obj[],
  waypoints?: Record<string, Array<{ x: number; y: number }>>,
): Promise<unknown[]> {
  return client.updateTokens(sceneId, updates, waypoints);
}

function summarizeToken(t: Obj, w: ReturnType<typeof world>): Obj {
  const actor = (w.actors as unknown as Obj[]).find((a) => a._id === t.actorId);
  const sight = (t.sight ?? {}) as Obj;
  return {
    id: t._id,
    name: t.name,
    x: t.x,
    y: t.y,
    width: t.width,
    height: t.height,
    elevation: t.elevation,
    hidden: Boolean(t.hidden),
    disposition: ({ '-2': 'secret', '-1': 'hostile', '0': 'neutral', '1': 'friendly' } as Obj)[
      String(t.disposition)
    ],
    actorId: t.actorId,
    actorName: actor?.name,
    actorLink: Boolean(t.actorLink),
    vision: Boolean(sight.enabled),
    visionRange: sight.range,
  };
}

function summarizeWall(wl: WallLike): Obj {
  return {
    id: wl._id,
    c: wl.c,
    door: DOOR_TYPES[wl.door ?? 0],
    ...(isDoor(wl) ? { state: doorState(wl) } : {}),
    move: wl.move,
    sight: wl.sight,
  };
}

export const sceneTools: GmToolSpec[] = [
  {
    name: 'duplicate_scene',
    description:
      'Copy a scene with all walls, doors, lights, notes, tokens, tiles, sounds and regions into a new scene (the original is untouched). Use for dry runs or per-session copies.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Source scene id or name' },
        name: { type: 'string', description: 'Name for the copy' },
        activate: { type: 'boolean', description: 'Activate the copy afterwards (default false)' },
      },
      required: ['sceneId', 'name'],
    },
    async run(client, args) {
      const src = getScene(client, str(args, 'sceneId'));
      const name = str(args, 'name') as string;
      const copy = structuredClone(src) as Obj;
      delete copy._id;
      delete copy._stats;
      copy.name = name;
      copy.active = false;
      const res = (await client.gmModify('Scene', 'create', { data: [copy] })) as Obj[];
      const created = res[0];
      if (!created?._id) {
        throw new GmToolError('Foundry returned no scene');
      }
      const newId = String(created._id);
      if (bool(args, 'activate', false)) {
        await client.gmModify('Scene', 'update', { updates: [{ _id: newId, active: true }] });
      }
      const counts: Obj = {};
      for (const k of [
        'walls',
        'lights',
        'notes',
        'tokens',
        'tiles',
        'sounds',
        'regions',
        'drawings',
      ]) {
        counts[k] = embedded(created, k).length;
      }
      return ok(`📋 Duplicated "${src.name}" → "${name}" (${newId})`, {
        sceneId: newId,
        sourceId: src._id,
        counts,
      });
    },
  },
  {
    name: 'activate_scene',
    description:
      'Make a scene the active scene and move every connected player onto it. ' +
      'Foundry only moves clients when the `active` flag actually changes, and a player ' +
      'who was pulled to another scene stays there, so this also sends pullToScene to ' +
      'every non-GM user (twice, to cover clients still loading a canvas).' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene id or name' },
        pullPlayers: {
          type: 'boolean',
          description: 'Pull all non-GM users onto the scene (default true)',
        },
        includeGMs: {
          type: 'boolean',
          description: 'Also pull GM users (default false)',
        },
      },
      required: ['sceneId'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId'));
      const wasActive = Boolean((scene as { active?: boolean }).active);
      // Setting active: true on an already-active scene is a no-op diff: the
      // server broadcasts nothing and no client switches. The server-side update
      // deactivates every other scene in the same operation.
      if (!wasActive) {
        await client.gmModify('Scene', 'update', { updates: [{ _id: scene._id, active: true }] });
      }
      const targets =
        (bool(args, 'pullPlayers', true) ?? true)
          ? pullTargets(client, bool(args, 'includeGMs', false) ?? false)
          : [];
      const pulled = await pullAndConfirm(client, scene._id, targets);
      return ok(
        `🎬 ${wasActive ? 'Already active' : 'Activated'} "${scene.name}" (${scene._id}); pulled ${targets.length} user(s): ${pullSummary(pulled)}`,
        pulled,
      );
    },
  },
  {
    name: 'view_scene',
    description:
      'Pull players\' views to a scene WITHOUT changing the active scene (Foundry "Pull to Scene"). Defaults to all users; pass userIds to target specific players.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string', description: 'Scene id or name' },
        userIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'User ids or names (default all)',
        },
      },
      required: ['sceneId'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId'));
      const keys = strList(args, 'userIds');
      const users = world(client).users ?? [];
      const targets = keys.length
        ? keys.map((k) => findByIdOrName(users as Array<{ _id: string; name: string }>, k, 'User'))
        : users;
      const pulled = await pullAndConfirm(client, scene._id, targets);
      return ok(
        `👁️ Pulled ${targets.length} user(s) to "${scene.name}": ${pullSummary(pulled)}`,
        pulled,
      );
    },
  },
  {
    name: 'get_scene_full',
    description:
      'Full read of a scene: walls (door type and open/closed/locked state), lights, notes (with linked journal), tokens (hidden, vision, disposition, actor link), sounds, tiles, regions, plus darkness, global light, token vision and fog settings. Use summary=true for counts only, include=[…] to limit sections, hiddenOnly to see only hidden tokens.',
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        include: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['walls', 'doors', 'lights', 'notes', 'tokens', 'sounds', 'tiles', 'regions'],
          },
          description:
            'Sections to return (default all except plain walls; "walls" returns every wall)',
        },
        summary: { type: 'boolean', description: 'Counts and settings only' },
        hiddenOnly: { type: 'boolean', description: 'Only hidden tokens' },
      },
    },
    async run(client, args) {
      const w = world(client);
      const s = getScene(client, str(args, 'sceneId', false));
      const walls = embedded(s, 'walls') as unknown as WallLike[];
      const doors = walls.filter(isDoor);
      const grid = s.grid as Obj | number | undefined;
      const fog = (s.fog ?? {}) as Obj;
      const out: Obj = {
        id: s._id,
        name: s.name,
        active: Boolean(s.active),
        width: s.width,
        height: s.height,
        gridSize: typeof grid === 'object' ? grid?.size : grid,
        padding: s.padding,
        darkness: sceneDarkness(s),
        globalLight: sceneGlobalLight(s),
        tokenVision: s.tokenVision,
        fogExploration: fog.exploration ?? s.fogExploration,
        fogReset: fog.reset ?? s.fogReset,
        counts: {
          walls: walls.length,
          doors: doors.length,
          doorsLocked: doors.filter((d) => doorState(d) === 'locked').length,
          doorsOpen: doors.filter((d) => doorState(d) === 'open').length,
          secretDoors: doors.filter((d) => d.door === 2).length,
          lights: embedded(s, 'lights').length,
          notes: embedded(s, 'notes').length,
          tokens: embedded(s, 'tokens').length,
          hiddenTokens: embedded(s, 'tokens').filter((t) => t.hidden).length,
          sounds: embedded(s, 'sounds').length,
          tiles: embedded(s, 'tiles').length,
          regions: embedded(s, 'regions').length,
        },
      };
      const warnings = defaultIconWarnings(s, w);
      if (warnings.length) {
        out.warnings = warnings;
      }
      if (bool(args, 'summary', false)) {
        return ok(`🗺️ ${s.name} (summary)`, out);
      }
      const inc = strList(args, 'include');
      const want = (k: string): boolean => (inc.length ? inc.includes(k) : k !== 'walls');
      if (want('walls')) {
        out.walls = walls.map(summarizeWall);
      }
      if (want('doors')) {
        out.doors = doors.map(summarizeWall);
      }
      if (want('tokens')) {
        let tokens = embedded(s, 'tokens');
        if (bool(args, 'hiddenOnly', false)) {
          tokens = tokens.filter((t) => t.hidden);
        }
        out.tokens = tokens.map((t) => summarizeToken(t, w));
      }
      if (want('lights')) {
        out.lights = embedded(s, 'lights').map((l) => {
          const cfg = (l.config ?? {}) as Obj;
          return {
            id: l._id,
            x: l.x,
            y: l.y,
            on: !l.hidden,
            dim: cfg.dim,
            bright: cfg.bright,
            color: cfg.color,
          };
        });
      }
      if (want('notes')) {
        const journals = w.journal as unknown as Obj[];
        out.notes = embedded(s, 'notes').map((n) => {
          const j = journals.find((x) => x._id === n.entryId);
          const page = embedded(j ?? {}, 'pages').find((p) => p._id === n.pageId);
          return {
            id: n._id,
            x: n.x,
            y: n.y,
            text: n.text,
            entryId: n.entryId,
            journal: j?.name,
            pageId: n.pageId,
            page: page?.name,
          };
        });
      }
      if (want('sounds')) {
        out.sounds = embedded(s, 'sounds').map((a) => ({
          id: a._id,
          x: a.x,
          y: a.y,
          path: a.path,
          radius: a.radius,
          on: !a.hidden,
        }));
      }
      if (want('tiles')) {
        out.tiles = embedded(s, 'tiles').map((t) => ({
          id: t._id,
          x: t.x,
          y: t.y,
          hidden: t.hidden,
          src: (t.texture as Obj)?.src,
        }));
      }
      if (want('regions')) {
        out.regions = embedded(s, 'regions').map((r) => ({
          id: r._id,
          name: r.name,
          behaviors: embedded(r, 'behaviors').map((b) => b.type),
        }));
      }
      return ok(`🗺️ ${s.name}`, out);
    },
  },
  {
    name: 'set_scene_darkness',
    description:
      'Set scene darkness 0 (daylight) to 1 (pitch dark) for time of day; optionally toggle global illumination.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        darkness: { type: 'number', minimum: 0, maximum: 1 },
        globalLight: { type: 'boolean' },
      },
      required: ['darkness'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const d = num(args, 'darkness') as number;
      if (d < 0 || d > 1) {
        throw new GmToolError('darkness must be between 0 and 1');
      }
      const upd: Obj = { _id: scene._id, 'environment.darknessLevel': d };
      const gl = bool(args, 'globalLight');
      if (gl !== undefined) {
        upd['environment.globalLight.enabled'] = gl;
      }
      await client.gmModify('Scene', 'update', { updates: [upd] });
      return ok(
        `🌗 "${scene.name}" darkness ${Math.round(d * 100)}%${gl !== undefined ? `, global light ${gl ? 'on' : 'off'}` : ''}`,
      );
    },
  },
  {
    name: 'create_token',
    description:
      "Place a token for a world actor on a scene at pixel x,y (top-left), using the actor's prototype token. Set hidden (GM-only) and vision. Use import_from_compendium first for compendium monsters." +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        actorId: { type: 'string', description: 'World actor id or name' },
        x: { type: 'number' },
        y: { type: 'number' },
        hidden: { type: 'boolean', description: 'Hidden from players (default false)' },
        vision: { type: 'boolean', description: 'Token has sight (default: prototype setting)' },
        visionRange: { type: 'number', description: 'Sight range in grid units' },
        name: { type: 'string', description: 'Override token name' },
        disposition: { type: 'string', enum: ['hostile', 'neutral', 'friendly', 'secret'] },
      },
      required: ['actorId', 'x', 'y'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const actor = getActor(client, str(args, 'actorId') as string);
      const proto = structuredClone((actor.prototypeToken ?? {}) as Obj);
      const sight = { ...((proto.sight ?? {}) as Obj) };
      const vision = bool(args, 'vision');
      if (vision !== undefined) {
        sight.enabled = vision;
      }
      const range = num(args, 'visionRange', false);
      if (range !== undefined) {
        sight.range = range;
      }
      const disp = str(args, 'disposition', false);
      const data: Obj = {
        ...proto,
        name: str(args, 'name', false) ?? proto.name ?? actor.name,
        actorId: actor._id,
        x: num(args, 'x'),
        y: num(args, 'y'),
        hidden: bool(args, 'hidden', false),
        sight,
        ...(disp
          ? { disposition: { secret: -2, hostile: -1, neutral: 0, friendly: 1 }[disp] }
          : {}),
      };
      delete data.randomImg;
      const res = (await client.gmModify('Token', 'create', {
        data: [data],
        parentUuid: `Scene.${scene._id}`,
      })) as Obj[];
      const t = res[0] ?? {};
      return ok(
        `🪙 Created token ${t.name} (${t._id}) on "${scene.name}"`,
        summarizeToken(t, world(client)),
      );
    },
  },
  {
    name: 'set_token_hidden',
    description: `Hide tokens from players or reveal them (e.g. reveal a monster).${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Token ids (or names in sceneId)',
        },
        hidden: { type: 'boolean' },
      },
      required: ['tokenIds', 'hidden'],
    },
    async run(client, args) {
      const hidden = bool(args, 'hidden') as boolean;
      const names: string[] = [];
      for (const id of strList(args, 'tokenIds', 'tokenId')) {
        const { token, scene } = locateToken(client, id, str(args, 'sceneId', false));
        await tokenUpdate(client, scene._id, [{ _id: token._id, hidden }]);
        names.push(`${token.name} (${token._id})`);
      }
      return ok(`${hidden ? '🙈 Hid' : '👀 Revealed'}: ${names.join(', ')}`);
    },
  },
  {
    name: 'set_token_vision',
    description: `Turn a token's sight on/off and optionally set its range (grid units).${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        tokenId: { type: 'string' },
        enabled: { type: 'boolean' },
        range: { type: 'number' },
      },
      required: ['tokenId', 'enabled'],
    },
    async run(client, args) {
      const { token, scene } = locateToken(
        client,
        str(args, 'tokenId') as string,
        str(args, 'sceneId', false),
      );
      const upd: Obj = { _id: token._id, 'sight.enabled': bool(args, 'enabled') };
      const range = num(args, 'range', false);
      if (range !== undefined) {
        upd['sight.range'] = range;
      }
      await tokenUpdate(client, scene._id, [upd]);
      return ok(
        `👁️ ${token.name}: vision ${upd['sight.enabled'] ? 'on' : 'off'}${range !== undefined ? `, range ${range}` : ''}`,
      );
    },
  },
  {
    name: 'delete_token',
    description: `Remove tokens from a scene (the actor is kept).${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: { ...sceneIdProp, tokenIds: { type: 'array', items: { type: 'string' } } },
      required: ['tokenIds'],
    },
    async run(client, args) {
      const byScene = new Map<string, string[]>();
      for (const id of strList(args, 'tokenIds', 'tokenId')) {
        const { token, scene } = locateToken(client, id, str(args, 'sceneId', false));
        byScene.set(scene._id, [...(byScene.get(scene._id) ?? []), token._id]);
      }
      let n = 0;
      for (const [sceneId, ids] of byScene) {
        n += (await client.gmModify('Token', 'delete', { ids, parentUuid: `Scene.${sceneId}` }))
          .length;
      }
      return ok(`🗑️ Deleted ${n} token(s)`);
    },
  },
  {
    name: 'move_token_checked',
    description:
      'Move a token to pixel x,y (or by dx/dy grid squares) only if it can walk there: finds a square-by-square route around movement-blocking walls and closed/locked doors (open doors pass). The token moves along that route. Refuses, naming the walls on the straight line, when no route exists unless force=true. Optional maxSteps caps the route length in squares. Approximate: ignores one-way walls, regions and terrain; not line of sight.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        tokenId: { type: 'string' },
        x: { type: 'number', description: 'Target top-left x in pixels' },
        y: { type: 'number', description: 'Target top-left y in pixels' },
        dx: { type: 'number', description: 'Grid squares to move right (negative = left)' },
        dy: { type: 'number', description: 'Grid squares to move down (negative = up)' },
        force: { type: 'boolean', description: 'Move even if walls block (GM teleport)' },
        maxSteps: {
          type: 'number',
          description: 'Refuse if the walking route is longer than this many squares',
        },
      },
      required: ['tokenId'],
    },
    async run(client, args) {
      const { token, scene } = locateToken(
        client,
        str(args, 'tokenId') as string,
        str(args, 'sceneId', false),
      );
      const grid = scene.grid as Obj | number | undefined;
      const size = Number((typeof grid === 'object' ? grid?.size : grid) ?? 100);
      const tx = Number(token.x ?? 0);
      const ty = Number(token.y ?? 0);
      let x = num(args, 'x', false);
      let y = num(args, 'y', false);
      const dx = num(args, 'dx', false);
      const dy = num(args, 'dy', false);
      if (x === undefined && y === undefined && dx === undefined && dy === undefined) {
        throw new GmToolError('Pass x,y or dx,dy');
      }
      x = x ?? tx + (dx ?? 0) * size;
      y = y ?? ty + (dy ?? 0) * size;
      const half = {
        x: (Number(token.width ?? 1) * size) / 2,
        y: (Number(token.height ?? 1) * size) / 2,
      };
      const from = { x: tx + half.x, y: ty + half.y };
      const to = { x: x + half.x, y: y + half.y };
      const walls = embedded(scene, 'walls') as unknown as WallLike[];
      const force = bool(args, 'force', false);
      const maxSteps = num(args, 'maxSteps', false);
      const dims = scene as { width?: number; height?: number; padding?: number };
      const pad = Number(dims.padding ?? 0.25);
      const w = Number(dims.width ?? 0);
      const h = Number(dims.height ?? 0);
      // Keep the route on the scene rectangle, inside the canvas padding.
      const padX = Math.ceil((w * pad) / size) * size;
      const padY = Math.ceil((h * pad) / size) * size;
      const bounds = w && h ? { x: padX, y: padY, width: w, height: h } : undefined;
      const path = force ? null : findGridPath(walls, from, to, { size, bounds });
      if (!force && (!path || (maxSteps !== undefined && path.steps > maxSteps))) {
        const blockers = findBlockingWalls(walls, from, to);
        const why = path
          ? `the shortest walking route is ${path.steps} squares, over maxSteps ${maxSteps}`
          : 'no walking route exists around the walls and closed doors';
        return ok(
          `🧱 Blocked: ${why}, between ${token.name} and (${x},${y}).${path ? '' : ' Open a door (set_door_state) or'} Pass force=true to move anyway.`,
          blockers.map((b) => ({ ...summarizeWall(b), midpoint: wallMidpoint(b) })),
        );
      }
      const waypoints = path
        ? path.points.slice(1, -1).map((p) => ({ x: p.x - half.x, y: p.y - half.y }))
        : [];
      await tokenUpdate(client, scene._id, [{ _id: token._id, x, y }], {
        [String(token._id)]: waypoints,
      });
      const route = path
        ? ` (${path.steps} square${path.steps === 1 ? '' : 's'}${waypoints.length ? `, ${waypoints.length} turn(s) around walls` : ''})`
        : ' [forced]';
      return ok(
        `🚶 Moved ${token.name} (${tx},${ty}) → (${x},${y})${route}`,
        path ? { waypoints } : undefined,
      );
    },
  },
  {
    name: 'list_doors',
    description:
      'List the doors on a scene with type (door/secret), state (open/closed/locked) and midpoint coordinates.',
    inputSchema: {
      type: 'object',
      properties: { ...sceneIdProp, state: { type: 'string', enum: ['open', 'closed', 'locked'] } },
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const want = str(args, 'state', false);
      const doors = (embedded(scene, 'walls') as unknown as WallLike[])
        .filter(isDoor)
        .filter((d) => !want || doorState(d) === want)
        .map((d) => ({ ...summarizeWall(d), midpoint: wallMidpoint(d) }));
      return ok(`🚪 ${doors.length} door(s) on "${scene.name}"`, doors);
    },
  },
  {
    name: 'set_door_state',
    description: `Open, close or lock a door wall. Fails if the wall is not a door.${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        wallId: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'locked'] },
      },
      required: ['wallId', 'state'],
    },
    async run(client, args) {
      const wallId = str(args, 'wallId') as string;
      const state = str(args, 'state') as 'open' | 'closed' | 'locked';
      if (!(state in DOOR_STATE_VALUES)) {
        throw new GmToolError('state must be open, closed or locked');
      }
      const sceneKey = str(args, 'sceneId', false);
      const scenes = sceneKey
        ? [getScene(client, sceneKey)]
        : (world(client).scenes as unknown as SceneObj[]);
      for (const scene of scenes) {
        const wall = (embedded(scene, 'walls') as unknown as WallLike[]).find(
          (x) => x._id === wallId,
        );
        if (!wall) {
          continue;
        }
        if (!isDoor(wall)) {
          throw new GmToolError(`Wall ${wallId} is not a door`);
        }
        const before = doorState(wall);
        await client.gmModify('Wall', 'update', {
          updates: [{ _id: wallId, ds: DOOR_STATE_VALUES[state] }],
          parentUuid: `Scene.${scene._id}`,
        });
        return ok(`🚪 Door ${wallId} on "${scene.name}": ${before} → ${state}`);
      }
      throw new GmToolError(`Wall ${wallId} not found`);
    },
  },
  {
    name: 'reset_fog',
    description: `Reset fog of war exploration for everyone on a scene, then read back the saved fog records to confirm. Players still viewing the scene save fresh records for what they currently see, so a non-zero count afterwards is normal; their timestamps are newer than the reset.${WRITE_NOTE}`,
    inputSchema: { type: 'object', properties: { ...sceneIdProp } },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const query = { query: { scene: scene._id } };
      const before = ((await client.gmGet('FogExploration', query)) as Obj[]) ?? [];
      await client.gmEmit('resetFog', scene._id);
      // A record is stale if it survives unchanged; players still on the scene
      // write new ones (new id or modified time). The server may finish the
      // deletion after acknowledging the emit, so poll briefly.
      const stamp = (f: Obj) =>
        `${String(f._id)}:${String((f._stats as Obj | undefined)?.modifiedTime ?? f.timestamp ?? '')}`;
      const old = new Set(before.map(stamp));
      let after: Obj[] = [];
      let stale: Obj[] = [];
      for (let i = 0; i < FOG_CONFIRM_POLLS; i++) {
        after = ((await client.gmGet('FogExploration', query)) as Obj[]) ?? [];
        stale = after.filter((f) => old.has(stamp(f)));
        if (!stale.length) {
          break;
        }
        await new Promise((r) => setTimeout(r, FOG_CONFIRM_INTERVAL_MS));
      }
      const confirmed = stale.length === 0;
      return ok(
        confirmed
          ? `🌫️ Fog reset on "${scene.name}": ${before.length} saved record(s) before, ${after.length} after (none left from before the reset)`
          : `⚠️ Fog reset sent on "${scene.name}" but ${stale.length} record(s) from before the reset remain; it may not have applied`,
        { before: before.length, after: after.length, stale: stale.length, confirmed },
      );
    },
  },
  {
    name: 'get_fog_state',
    description:
      'Read which users have explored fog saved on a scene and when it was last updated (no image data).',
    inputSchema: { type: 'object', properties: { ...sceneIdProp } },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const res = (await client.gmGet('FogExploration', { query: { scene: scene._id } })) as Obj[];
      const users = world(client).users ?? [];
      const rows = res.map((f) => ({
        id: f._id,
        user: users.find((u) => u._id === f.user)?.name ?? f.user,
        exploredBytes: typeof f.explored === 'string' ? f.explored.length : 0,
        timestamp: f.timestamp ? new Date(Number(f.timestamp)).toISOString() : undefined,
      }));
      return ok(`🌫️ ${rows.length} fog exploration record(s) on "${scene.name}"`, rows);
    },
  },
  {
    name: 'set_light_state',
    description: `Turn ambient lights on or off on a scene.${WRITE_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...sceneIdProp,
        lightIds: { type: 'array', items: { type: 'string' } },
        on: { type: 'boolean' },
      },
      required: ['lightIds', 'on'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const on = bool(args, 'on') as boolean;
      const ids = strList(args, 'lightIds', 'lightId');
      const res = await client.gmModify('AmbientLight', 'update', {
        updates: ids.map((_id) => ({ _id, hidden: !on })),
        parentUuid: `Scene.${scene._id}`,
      });
      return ok(`💡 ${res.length} light(s) ${on ? 'on' : 'off'} on "${scene.name}"`);
    },
  },
  {
    name: 'get_note_page',
    description: 'Read the journal entry/page linked from a map note (pin) as plain text.',
    inputSchema: {
      type: 'object',
      properties: { ...sceneIdProp, noteId: { type: 'string' }, maxChars: { type: 'number' } },
      required: ['noteId'],
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const note = findByIdOrName(
        embedded(scene, 'notes') as Array<Obj & { _id: string; name?: string }>,
        str(args, 'noteId') as string,
        'Note',
      );
      const j = (world(client).journal as unknown as Obj[]).find((x) => x._id === note.entryId);
      if (!j) {
        return ok(`📌 Note ${note._id} "${note.text ?? ''}" has no linked journal`);
      }
      const pages = embedded(j, 'pages');
      const chosen = note.pageId ? pages.filter((p) => p._id === note.pageId) : pages;
      const max = num(args, 'maxChars', false) ?? 3000;
      const text = chosen
        .map(
          (p) =>
            `## ${p.name}\n${stripHtml((p.text as Obj)?.content ?? '', max)}${(p.src as string) ? `\n[image: ${p.src}]` : ''}`,
        )
        .join('\n\n');
      return ok(
        `📌 ${j.name}${note.pageId ? ` › ${chosen[0]?.name ?? note.pageId}` : ''} (JournalEntry.${j._id})\n\n${text}`,
      );
    },
  },
];

/**
 * Shared helpers for the GM toolkit tools.
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { WorldData } from '../../foundry/types.js';
import type { ToolResult } from '../base.js';

export type Obj = Record<string, unknown>;

export class GmToolError extends Error {}

/** Text result with an optional JSON payload appended for machine reading. */
export function ok(text: string, data?: unknown): ToolResult {
  const body =
    data === undefined ? text : `${text}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  return { content: [{ type: 'text', text: body }] };
}

export function world(client: FoundryClient): WorldData {
  const w = client.getWorld();
  if (!w) {
    throw new GmToolError('World data is not loaded yet (no live socket). Try refresh_world_data.');
  }
  return w;
}

export function str(args: Obj, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) {
      throw new GmToolError(`Missing required argument: ${key}`);
    }
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new GmToolError(`Argument ${key} must be a string`);
  }
  return v;
}

export function num(args: Obj, key: string, required = true): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    if (required) {
      throw new GmToolError(`Missing required argument: ${key}`);
    }
    return undefined;
  }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new GmToolError(`Argument ${key} must be a number`);
  }
  return n;
}

export function bool(args: Obj, key: string, dflt?: boolean): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) {
    return dflt;
  }
  if (typeof v !== 'boolean') {
    throw new GmToolError(`Argument ${key} must be a boolean`);
  }
  return v;
}

export function strList(args: Obj, key: string, singular?: string): string[] {
  const v = args[key] ?? (singular ? args[singular] : undefined);
  if (v === undefined || v === null) {
    return [];
  }
  const list = Array.isArray(v) ? v : [v];
  if (!list.every((x) => typeof x === 'string' && x.length > 0)) {
    throw new GmToolError(`Argument ${key} must be a string or list of strings`);
  }
  return list as string[];
}

/** Find by exact id, then case-insensitive exact name, then unique substring. */
export function findByIdOrName<T extends { _id: string; name?: string }>(
  list: T[] | undefined,
  key: string,
  what: string,
): T {
  const items = list ?? [];
  const byId = items.find((i) => i._id === key);
  if (byId) {
    return byId;
  }
  const k = key.toLowerCase();
  const exact = items.filter((i) => (i.name ?? '').toLowerCase() === k);
  if (exact.length === 1) {
    return exact[0] as T;
  }
  if (exact.length > 1) {
    throw new GmToolError(
      `${what} name "${key}" is ambiguous (${exact.map((i) => i._id).join(', ')}); pass the id`,
    );
  }
  const partial = items.filter((i) => (i.name ?? '').toLowerCase().includes(k));
  if (partial.length === 1) {
    return partial[0] as T;
  }
  if (partial.length > 1) {
    throw new GmToolError(
      `${what} "${key}" matches several: ${partial
        .slice(0, 8)
        .map((i) => `${i.name} (${i._id})`)
        .join(', ')}`,
    );
  }
  throw new GmToolError(`${what} not found: ${key}`);
}

export type SceneObj = Obj & { _id: string; name: string };

export function getScene(client: FoundryClient, key: string | undefined): SceneObj {
  const w = world(client);
  const scenes = w.scenes as unknown as SceneObj[];
  if (!key) {
    const active = scenes.find((s) => s.active);
    if (!active) {
      throw new GmToolError('No sceneId given and no scene is active');
    }
    return active;
  }
  return findByIdOrName(scenes, key, 'Scene');
}

export function embedded(scene: Obj, key: string): Obj[] {
  const v = scene[key];
  return Array.isArray(v) ? (v as Obj[]) : [];
}

/** Locate a token anywhere (or in one scene). Returns token + its scene. */
export function locateToken(
  client: FoundryClient,
  tokenKey: string,
  sceneKey?: string,
): { token: Obj & { _id: string }; scene: SceneObj } {
  const scenes = sceneKey
    ? [getScene(client, sceneKey)]
    : (world(client).scenes as unknown as SceneObj[]);
  for (const scene of scenes) {
    const tokens = embedded(scene, 'tokens') as Array<Obj & { _id: string; name?: string }>;
    const t = tokens.find((x) => x._id === tokenKey);
    if (t) {
      return { token: t, scene };
    }
  }
  // Name lookup only inside a single scene (names repeat across scenes).
  const scene = getScene(client, sceneKey);
  const tokens = embedded(scene, 'tokens') as Array<Obj & { _id: string; name?: string }>;
  return { token: findByIdOrName(tokens, tokenKey, 'Token'), scene };
}

export type ActorObj = Obj & { _id: string; name: string; type?: string; system?: Obj };

export function getActor(client: FoundryClient, key: string): ActorObj {
  return findByIdOrName(world(client).actors as unknown as ActorObj[], key, 'Actor');
}

export function gmUserIds(client: FoundryClient): string[] {
  return (world(client).users ?? []).filter((u) => (u.role ?? 0) >= 4).map((u) => u._id);
}

export function resolveUserIds(client: FoundryClient, keys: string[]): string[] {
  const users = world(client).users ?? [];
  return keys.map(
    (k) => findByIdOrName(users as Array<{ _id: string; name: string }>, k, 'User')._id,
  );
}

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);
}

export function stripHtml(html: unknown, max = 2000): string {
  const s = String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|li|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function pdtNow(): string {
  return new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
}

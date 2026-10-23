/**
 * Relay to the covert-ops-d20 system's in-browser rules (module/bridge/derived-cache.mjs).
 *
 * A headless socket client cannot run system code, so when a GM browser client
 * is connected we write `flags.covert-ops-d20.bridgeRequest` on the actor (or the
 * unlinked token's delta) and wait for that client to answer in `bridgeResult`.
 * The GM client also keeps `flags.covert-ops-d20.derived` (prepared actor data).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { getPath, type Obj, type resolveTarget, world } from './helpers.js';
import { COVERT_OPS_ID } from './systems/covert-ops.js';

type Target = ReturnType<typeof resolveTarget>;

/** True when a GM user other than this bridge is connected (a browser that can run system code). */
export function gmBrowserActive(client: FoundryClient): boolean {
  const w = world(client);
  const me = String(w.userId ?? '');
  const active = new Set((w.activeUsers ?? []) as string[]);
  return (w.users ?? []).some(
    (u) =>
      (u as unknown as Obj)._id !== me &&
      Number((u as unknown as Obj).role ?? 0) >= 4 &&
      active.has(String((u as unknown as Obj)._id)),
  );
}

/** Current actor/token from the live cache (the target object may be a stale snapshot). */
function liveFlags(client: FoundryClient, t: Target): Obj | undefined {
  const w = world(client);
  if (t.unlinked && t.token && t.sceneId) {
    const scene = ((w.scenes ?? []) as unknown as Obj[]).find((s) => s._id === t.sceneId);
    const tok = ((scene?.tokens as Obj[] | undefined) ?? []).find((x) => x._id === t.token?._id);
    return getPath(tok, `delta.flags.${COVERT_OPS_ID}`) as Obj | undefined;
  }
  const actor = ((w.actors ?? []) as unknown as Obj[]).find((a) => a._id === t.actor._id);
  return getPath(actor, `flags.${COVERT_OPS_ID}`) as Obj | undefined;
}

export interface BridgeResult extends Obj {
  id: string;
  ok: boolean;
  lines?: string[];
  damage?: number;
  ouch?: { damage: number } | null;
  derived?: Obj;
  error?: string;
}

/**
 * Send a request to the GM browser and wait for its answer. Resolves undefined
 * when no GM browser is connected or it does not answer within timeoutMs.
 */
export async function bridgeRequest(
  client: FoundryClient,
  t: Target,
  payload: Obj,
  timeoutMs = 6000,
  pollMs = 100,
): Promise<BridgeResult | undefined> {
  if (!gmBrowserActive(client)) {
    return undefined;
  }
  const id = `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const key = `flags.${COVERT_OPS_ID}.bridgeRequest`;
  if (t.unlinked && t.token && t.sceneId) {
    await client.gmModify('Token', 'update', {
      updates: [{ _id: t.token._id, [`delta.${key}`]: { id, ...payload } }],
      parentUuid: `Scene.${t.sceneId}`,
      diff: true,
    });
  } else {
    await client.gmModify('Actor', 'update', {
      updates: [{ _id: t.actor._id, [key]: { id, ...payload } }],
      diff: true,
    });
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const res = liveFlags(client, t)?.bridgeResult as BridgeResult | undefined;
    if (res?.id === id) {
      return res;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return undefined;
}

export function mergeDeep(a: Obj, b: Obj): Obj {
  const out: Obj = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] =
      v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object'
        ? mergeDeep(a[k] as Obj, v as Obj)
        : v;
  }
  return out;
}

/**
 * The target as the system sees it: token delta (system, flags, items) merged
 * over the base actor, with a fresh derived snapshot from the GM browser when
 * one is connected and the cache is missing (unlinked tokens are never cached
 * automatically). Without a GM browser, covertOpsSummary recomputes.
 */
export async function covertActor(client: FoundryClient, t: Target, refresh = false): Promise<Obj> {
  return (await covertActorStatus(client, t, refresh)).actor;
}

/**
 * covertActor plus whether a GM browser answered with a fresh derived snapshot.
 * fresh=false means any derived values come from the (possibly stale) cache.
 */
export async function covertActorStatus(
  client: FoundryClient,
  t: Target,
  refresh = false,
): Promise<{ actor: Obj; fresh: boolean }> {
  let fresh = false;
  const delta = (t.unlinked ? t.token?.delta : undefined) as Obj | undefined;
  let actor: Obj = delta
    ? {
        ...t.actor,
        system: mergeDeep((t.actor.system ?? {}) as Obj, (delta.system ?? {}) as Obj),
        flags: mergeDeep((t.actor.flags ?? {}) as Obj, (delta.flags ?? {}) as Obj),
        ...(Array.isArray(delta.items) ? { items: delta.items } : {}),
      }
    : t.actor;
  if (delta) {
    // A base actor's cache does not describe the token's own vitality etc.
    const f = (actor.flags as Obj)[COVERT_OPS_ID] as Obj | undefined;
    if (f && !getPath(delta, `flags.${COVERT_OPS_ID}.derived`)) {
      actor = {
        ...actor,
        flags: { ...(actor.flags as Obj), [COVERT_OPS_ID]: { ...f, derived: undefined } },
      };
    }
  }
  const cached = getPath(actor, `flags.${COVERT_OPS_ID}.derived`);
  if ((refresh || delta || !cached) && gmBrowserActive(client)) {
    const res = await bridgeRequest(client, t, { op: 'derive' }, 3000);
    if (res?.ok && res.derived) {
      fresh = true;
      const f = ((actor.flags as Obj | undefined)?.[COVERT_OPS_ID] ?? {}) as Obj;
      actor = {
        ...actor,
        flags: { ...((actor.flags ?? {}) as Obj), [COVERT_OPS_ID]: { ...f, derived: res.derived } },
      };
    }
  }
  return { actor, fresh };
}

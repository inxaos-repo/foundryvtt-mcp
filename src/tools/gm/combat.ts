/**
 * Combat encounter tools. Turn indices follow Foundry's initiative-sorted
 * turn order (descending initiative, ties by name then id).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { evaluateDiceFormula } from '../../foundry/dice-formula.js';
import type { WorldCombat } from '../../foundry/types.js';
import {
  compareCombatants,
  type TurnOrderContext,
  turnOrderContext,
  type WorldCombatant,
} from '../handlers/combat-order.js';
import {
  bool,
  embedded,
  GmToolError,
  getScene,
  locateToken,
  type Obj,
  ok,
  str,
  strList,
  world,
} from './helpers.js';
import { getSystemAdapter } from './systems/registry.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

// ---------------------------------------------------------------------------
// Combat helpers
// ---------------------------------------------------------------------------

type CombatObj = Obj & { _id: string; round?: number; turn?: number | null; combatants?: Obj[] };

export function sortTurns(combatants: Obj[], ctx?: TurnOrderContext): Obj[] {
  if (ctx?.systemId === 'ose') {
    // Same comparator as the legacy handlers + turn_context (OSE tie-break).
    return [...combatants].sort((a, b) =>
      compareCombatants(a as unknown as WorldCombatant, b as unknown as WorldCombatant, ctx),
    );
  }
  return [...combatants].sort((a, b) => {
    const ia = typeof a.initiative === 'number' ? a.initiative : -Infinity;
    const ib = typeof b.initiative === 'number' ? b.initiative : -Infinity;
    if (ib !== ia) {
      return ib > ia ? 1 : -1;
    }
    const n = String(a.name ?? '').localeCompare(String(b.name ?? ''));
    return n !== 0 ? n : String(a._id).localeCompare(String(b._id));
  });
}

function getCombat(client: FoundryClient, combatId?: string): CombatObj {
  const combats = (world(client).combats ?? []) as unknown as CombatObj[];
  if (combatId) {
    const c = combats.find((x) => x._id === combatId);
    if (!c) {
      throw new GmToolError(`Combat ${combatId} not found`);
    }
    return c;
  }
  const c = combats.find((x) => x.active) ?? combats[combats.length - 1];
  if (!c) {
    throw new GmToolError('No combat encounter exists');
  }
  return c;
}

function turnOrder(client: FoundryClient, c: CombatObj): Obj {
  const w = world(client);
  const ctx = turnOrderContext(w, c as unknown as WorldCombat);
  const turns = sortTurns(c.combatants ?? [], ctx);
  const actors = w.actors as unknown as Obj[];
  return {
    combatId: c._id,
    round: c.round ?? 0,
    turn: c.turn ?? 0,
    started: (c.round ?? 0) > 0,
    order: turns.map((t, i) => ({
      index: i,
      current: (c.round ?? 0) > 0 && i === (c.turn ?? 0),
      combatantId: t._id,
      name: ctx
        ? ctx.displayName(t as unknown as WorldCombatant)
        : t.name || actors.find((a) => a._id === t.actorId)?.name,
      tokenId: t.tokenId,
      initiative: t.initiative ?? null,
      defeated: Boolean(t.defeated),
      hidden: Boolean(t.hidden),
    })),
  };
}

export function advance(
  round: number,
  turn: number,
  count: number,
  action: string,
): { round: number; turn: number } {
  const n = Math.max(count, 1);
  switch (action) {
    case 'begin':
      return { round: 1, turn: 0 };
    case 'next_turn':
      if (round < 1) {
        return { round: 1, turn: 0 };
      }
      return turn + 1 >= n ? { round: round + 1, turn: 0 } : { round, turn: turn + 1 };
    case 'previous_turn':
      if (turn > 0) {
        return { round, turn: turn - 1 };
      }
      return round > 1 ? { round: round - 1, turn: n - 1 } : { round, turn: 0 };
    case 'next_round':
      return { round: round + 1, turn: 0 };
    case 'previous_round':
      return { round: Math.max(round - 1, 1), turn: 0 };
    default:
      throw new GmToolError(`Unknown combat action ${action}`);
  }
}

/**
 * OSE's world setting `ose.initiative` ("group" | "individual"); the system
 * registers "group" as the default, so a world that never changed it has no
 * stored value and uses group initiative.
 */
export function oseGroupInitiative(client: FoundryClient): boolean {
  const w = world(client);
  if (String((w.system as Obj | undefined)?.id ?? '') !== 'ose') {
    return false;
  }
  const entry = ((w.settings ?? []) as Obj[]).find((s) => s?.key === 'ose.initiative');
  if (!entry) {
    return true;
  }
  let v: unknown = entry.value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      // stored unquoted
    }
  }
  return v !== 'individual';
}

/** Mirrors `OSECombatant#groupRaw` for a token that has no group yet. */
export function oseGroupKey(client: FoundryClient, token: Obj | undefined): string {
  const actors = (world(client).actors ?? []) as unknown as Obj[];
  const actor = actors.find((a) => a._id === token?.actorId);
  if (getPathSafe(actor, 'system.isSlow')) {
    return 'slow';
  }
  switch (token?.disposition) {
    case -1:
      return 'red';
    case 0:
      return 'purple';
    case 1:
      return 'green';
    default:
      return 'white';
  }
}

function getPathSafe(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);
}

function findToken(
  client: FoundryClient,
  sceneId: string | undefined,
  tokenId: unknown,
): Obj | undefined {
  const scenes = (world(client).scenes ?? []) as unknown as Obj[];
  const pool = sceneId ? scenes.filter((s) => s._id === sceneId) : scenes;
  for (const s of pool) {
    const t = embedded(s, 'tokens').find((x) => x._id === tokenId);
    if (t) {
      return t;
    }
  }
  return undefined;
}

/**
 * OSE group initiative: make sure a CombatantGroup exists for every key in
 * `keys` (reusing the combat's existing groups by name), roll one d6 per
 * group (the "slow" group is never rolled, as in OSE) and return
 * name -> { id, initiative }.
 */
async function rollOseGroups(
  client: FoundryClient,
  combatId: string,
  existing: Obj[],
  keys: string[],
): Promise<Map<string, { id: string; initiative: number | null }>> {
  const out = new Map<string, { id: string; initiative: number | null }>();
  const wanted = [...new Set(keys)];
  const missing = wanted.filter((k) => !existing.some((g) => g.name === k));
  let created: Obj[] = [];
  if (missing.length) {
    created = ((await client.gmModify('CombatantGroup', 'create', {
      data: missing.map((name) => ({ name, initiative: null })),
      parentUuid: `Combat.${combatId}`,
    })) ?? []) as Obj[];
  }
  const all = [...existing, ...created];
  const updates: Obj[] = [];
  for (const k of wanted) {
    const g = all.find((x) => x.name === k);
    if (!g?._id) {
      throw new GmToolError(`Could not create OSE initiative group ${k}`);
    }
    const initiative = k === 'slow' ? null : evaluateDiceFormula('1d6').total;
    out.set(k, { id: String(g._id), initiative });
    if (initiative !== null) {
      updates.push({ _id: g._id, initiative });
    }
  }
  if (updates.length) {
    await client.gmModify('CombatantGroup', 'update', {
      updates,
      parentUuid: `Combat.${combatId}`,
    });
  }
  return out;
}

function defaultInitiative(client: FoundryClient): string {
  const systemId = String((world(client).system as Obj | undefined)?.id ?? '');
  return getSystemAdapter(systemId)?.initiativeFormula ?? '1d20';
}

export const combatTools: GmToolSpec[] = [
  {
    name: 'start_encounter',
    description:
      'Create a combat encounter on a scene from token ids (or all non-hidden tokens), optionally roll initiative and begin round 1. OSE uses the system initiative setting: group mode (default) rolls one d6 per side (friendly/hostile/neutral) shared by its members. revealHidden unhides hidden tokens and combatants. Returns the turn order.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Default: all visible tokens',
        },
        rollInitiative: { type: 'boolean', description: 'Default true' },
        formula: {
          type: 'string',
          description: 'Initiative formula (default: system adapter, else 1d20)',
        },
        begin: { type: 'boolean', description: 'Start round 1 (default true)' },
        revealHidden: {
          type: 'boolean',
          description: 'Unhide the listed hidden tokens and their combatants (default false)',
        },
      },
    },
    async run(client, args) {
      const scene = getScene(client, str(args, 'sceneId', false));
      const keys = strList(args, 'tokenIds', 'tokenId');
      const tokens = keys.length
        ? keys.map((k) => locateToken(client, k, scene._id).token)
        : (embedded(scene, 'tokens').filter((t) => !t.hidden) as Array<Obj & { _id: string }>);
      if (!tokens.length) {
        throw new GmToolError('No tokens to add');
      }
      const created = (await client.gmModify('Combat', 'create', {
        data: [{ scene: scene._id, active: true, round: 0, turn: 0 }],
      })) as Obj[];
      const combatId = String(created[0]?._id ?? '');
      if (!combatId) {
        throw new GmToolError('Foundry returned no Combat id');
      }
      const explicitFormula = str(args, 'formula', false);
      const formula = explicitFormula ?? defaultInitiative(client);
      const roll = bool(args, 'rollInitiative', true);
      const reveal = bool(args, 'revealHidden', false);
      const toReveal = reveal ? tokens.filter((t) => t.hidden) : [];
      if (toReveal.length) {
        await client.gmModify('Token', 'update', {
          updates: toReveal.map((t) => ({ _id: t._id, hidden: false })),
          parentUuid: `Scene.${scene._id}`,
        });
      }
      // OSE group mode: one d6 per side, shared by every member (and the
      // CombatantGroup OSE's tracker shows). An explicit formula opts out.
      const grouped = oseGroupInitiative(client) && !explicitFormula;
      const keyOf = new Map(tokens.map((t) => [t._id, oseGroupKey(client, t)]));
      const groups = grouped
        ? await rollOseGroups(client, combatId, [], [...keyOf.values()])
        : undefined;
      const data = tokens.map((t) => {
        const g = groups?.get(keyOf.get(t._id) as string);
        const initiative = g ? g.initiative : evaluateDiceFormula(formula).total;
        return {
          tokenId: t._id,
          sceneId: scene._id,
          actorId: t.actorId,
          hidden: reveal ? false : Boolean(t.hidden),
          ...(g ? { group: g.id } : {}),
          ...(roll && initiative !== null ? { initiative } : {}),
        };
      });
      if (groups && !roll) {
        await client.gmModify('CombatantGroup', 'update', {
          updates: [...groups.values()].map((g) => ({ _id: g.id, initiative: null })),
          parentUuid: `Combat.${combatId}`,
        });
      }
      await client.gmModify('Combatant', 'create', { data, parentUuid: `Combat.${combatId}` });
      if (bool(args, 'begin', true)) {
        await client.gmModify('Combat', 'update', {
          updates: [{ _id: combatId, round: 1, turn: 0 }],
        });
      }
      return ok(
        `⚔️ Encounter ${combatId} with ${data.length} combatant(s)`,
        turnOrder(client, getCombat(client, combatId)),
      );
    },
  },
  {
    name: 'roll_initiative',
    description:
      'Roll initiative for combatants in a combat (default: those without initiative) and return the new turn order.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        combatId: { type: 'string', description: 'Default: active combat' },
        combatantIds: { type: 'array', items: { type: 'string' } },
        formula: { type: 'string', description: 'Default: system adapter, else 1d20' },
        rerollAll: { type: 'boolean' },
      },
    },
    async run(client, args) {
      const c = getCombat(client, str(args, 'combatId', false));
      const ids = strList(args, 'combatantIds');
      const explicitFormula = str(args, 'formula', false);
      const formula = explicitFormula ?? defaultInitiative(client);
      const targets = (c.combatants ?? []).filter((x) =>
        ids.length
          ? ids.includes(String(x._id))
          : bool(args, 'rerollAll', false) || typeof x.initiative !== 'number',
      );
      if (!targets.length) {
        return ok('🎲 Nobody needs initiative', turnOrder(client, c));
      }
      if (oseGroupInitiative(client) && !explicitFormula) {
        // Group mode: re-roll each affected side once and give every member
        // of that side (not just the targets) the same result.
        const existing = ((c as Obj).groups ?? []) as Obj[];
        const keyFor = (x: Obj): string => {
          const named = existing.find((g) => g._id === x.group)?.name;
          return typeof named === 'string' && named
            ? named
            : oseGroupKey(
                client,
                findToken(client, String(x.sceneId ?? (c as Obj).scene ?? ''), x.tokenId),
              );
        };
        const groups = await rollOseGroups(client, c._id, existing, targets.map(keyFor));
        const members = (c.combatants ?? []).filter((x) => groups.has(keyFor(x)));
        await client.gmModify('Combatant', 'update', {
          updates: members.map((m) => {
            const g = groups.get(keyFor(m)) as { id: string; initiative: number | null };
            return { _id: m._id, group: g.id, initiative: g.initiative };
          }),
          parentUuid: `Combat.${c._id}`,
        });
        const summary = [...groups.entries()]
          .map(([k, g]) => `${k} ${g.initiative ?? '-'}`)
          .join(', ');
        return ok(`🎲 Group initiative: ${summary}`, turnOrder(client, getCombat(client, c._id)));
      }
      await client.gmModify('Combatant', 'update', {
        updates: targets.map((t) => ({
          _id: t._id,
          initiative: evaluateDiceFormula(formula).total,
        })),
        parentUuid: `Combat.${c._id}`,
      });
      return ok(
        `🎲 Rolled initiative for ${targets.length}`,
        turnOrder(client, getCombat(client, c._id)),
      );
    },
  },
  {
    name: 'combat_control',
    description:
      'Run the active combat: begin, next_turn, previous_turn, next_round, previous_round or end (deletes the encounter). Returns the turn order with the current combatant.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['begin', 'next_turn', 'previous_turn', 'next_round', 'previous_round', 'end'],
        },
        combatId: { type: 'string' },
      },
      required: ['action'],
    },
    async run(client, args) {
      const c = getCombat(client, str(args, 'combatId', false));
      const action = str(args, 'action') as string;
      if (action === 'end') {
        const summary = turnOrder(client, c);
        await client.gmModify('Combat', 'delete', { ids: [c._id] });
        return ok(`🏁 Combat ${c._id} ended after round ${c.round ?? 0}`, summary);
      }
      const next = advance(c.round ?? 0, c.turn ?? 0, (c.combatants ?? []).length, action);
      await client.gmModify('Combat', 'update', { updates: [{ _id: c._id, ...next }] });
      const order = turnOrder(client, getCombat(client, c._id));
      const cur = (order.order as Obj[]).find((o) => o.current);
      return ok(`⚔️ Round ${next.round}, turn ${next.turn + 1}: ${cur?.name ?? '?'}`, order);
    },
  },
  {
    name: 'get_turn_order',
    description:
      'Read the current combat: round, turn, and combatants sorted by initiative with the current one marked.',
    inputSchema: { type: 'object', properties: { combatId: { type: 'string' } } },
    async run(client, args) {
      return ok('⚔️ Turn order', turnOrder(client, getCombat(client, str(args, 'combatId', false))));
    },
  },
];

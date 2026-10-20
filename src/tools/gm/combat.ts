/**
 * Combat encounter tools. Turn indices follow Foundry's initiative-sorted
 * turn order (descending initiative, ties by name then id).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { evaluateDiceFormula } from '../../foundry/dice-formula.js';
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

export function sortTurns(combatants: Obj[]): Obj[] {
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
  const turns = sortTurns(c.combatants ?? []);
  const actors = world(client).actors as unknown as Obj[];
  return {
    combatId: c._id,
    round: c.round ?? 0,
    turn: c.turn ?? 0,
    started: (c.round ?? 0) > 0,
    order: turns.map((t, i) => ({
      index: i,
      current: (c.round ?? 0) > 0 && i === (c.turn ?? 0),
      combatantId: t._id,
      name: t.name || actors.find((a) => a._id === t.actorId)?.name,
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

function defaultInitiative(client: FoundryClient): string {
  const systemId = String((world(client).system as Obj | undefined)?.id ?? '');
  return getSystemAdapter(systemId)?.initiativeFormula ?? '1d20';
}

export const combatTools: GmToolSpec[] = [
  {
    name: 'start_encounter',
    description:
      'Create a combat encounter on a scene from token ids (or all non-hidden tokens), optionally roll initiative and begin round 1. Returns the turn order.' +
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
      const formula = str(args, 'formula', false) ?? defaultInitiative(client);
      const roll = bool(args, 'rollInitiative', true);
      const data = tokens.map((t) => ({
        tokenId: t._id,
        sceneId: scene._id,
        actorId: t.actorId,
        hidden: Boolean(t.hidden),
        ...(roll ? { initiative: evaluateDiceFormula(formula).total } : {}),
      }));
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
      const formula = str(args, 'formula', false) ?? defaultInitiative(client);
      const targets = (c.combatants ?? []).filter((x) =>
        ids.length
          ? ids.includes(String(x._id))
          : bool(args, 'rerollAll', false) || typeof x.initiative !== 'number',
      );
      if (!targets.length) {
        return ok('🎲 Nobody needs initiative', turnOrder(client, c));
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

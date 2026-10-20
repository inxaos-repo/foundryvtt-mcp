/**
 * GM toolkit — chat, dice, OSE system rolls, combat, actor state, sharing,
 * audio, users, compendium import and rule lookup.
 */

import type { FoundryClient } from '../../foundry/client.js';
import { type DiceFormulaResult, evaluateDiceFormula } from '../../foundry/dice-formula.js';
import {
  type ActorObj,
  bool,
  embedded,
  findByIdOrName,
  GmToolError,
  getActor,
  getPath,
  getScene,
  gmUserIds,
  locateToken,
  num,
  type Obj,
  ok,
  resolveUserIds,
  str,
  stripHtml,
  strList,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './scene-tools.js';

// ---------------------------------------------------------------------------
// Rolls → Foundry chat
// ---------------------------------------------------------------------------

/** Serialise an evaluated formula as Foundry Roll JSON (v11+ term classes). */
export function toFoundryRoll(formula: string, r: DiceFormulaResult): Obj {
  const terms: Obj[] = [];
  r.terms.forEach((t, i) => {
    if (i > 0 || t.sign < 0) {
      terms.push({
        class: 'OperatorTerm',
        operator: t.sign < 0 ? '-' : '+',
        options: {},
        evaluated: true,
      });
    }
    if (t.kind === 'dice') {
      terms.push({
        class: 'Die',
        options: {},
        evaluated: true,
        number: t.count,
        faces: t.sides,
        modifiers: [],
        results: t.rolls.map((result) => ({ result, active: true })),
      });
    } else {
      terms.push({ class: 'NumericTerm', options: {}, evaluated: true, number: t.value });
    }
  });
  return { class: 'Roll', options: {}, dice: [], formula, terms, total: r.total, evaluated: true };
}

export type RollMode = 'public' | 'gm' | 'blind' | 'self';

function speakerFor(client: FoundryClient, args: Obj): Obj {
  const tokenId = str(args, 'tokenId', false);
  const actorId = str(args, 'actorId', false);
  const alias = str(args, 'alias', false);
  if (tokenId) {
    const { token, scene } = locateToken(client, tokenId, str(args, 'sceneId', false));
    return {
      scene: scene._id,
      token: token._id,
      actor: token.actorId ?? null,
      alias: alias ?? token.name,
    };
  }
  if (actorId) {
    const a = getActor(client, actorId);
    return { actor: a._id, alias: alias ?? a.name };
  }
  return { alias: alias ?? 'Game Master' };
}

async function postRoll(
  client: FoundryClient,
  formula: string,
  flavor: string,
  mode: RollMode,
  speaker: Obj,
  content?: string,
): Promise<{ result: DiceFormulaResult; messageId: unknown }> {
  const result = evaluateDiceFormula(formula);
  const w = world(client);
  const msg: Obj = {
    author: w.userId,
    speaker,
    flavor,
    content: content ?? String(result.total),
    rolls: [JSON.stringify(toFoundryRoll(formula, result))],
    sound: 'sounds/dice.wav',
  };
  if (mode === 'gm' || mode === 'blind') {
    msg.whisper = gmUserIds(client);
  }
  if (mode === 'blind') {
    msg.blind = true;
  }
  if (mode === 'self') {
    msg.whisper = [w.userId];
  }
  const res = (await client.gmModify('ChatMessage', 'create', { data: [msg] })) as Obj[];
  return { result, messageId: res[0]?._id };
}

const rollModeProp = {
  mode: {
    type: 'string',
    enum: ['public', 'gm', 'blind', 'self'],
    description: 'public (default), gm (whisper to GMs), blind (GMs only, roller cannot see), self',
  },
};

// ---------------------------------------------------------------------------
// HP / actor helpers
// ---------------------------------------------------------------------------

const HP_PATHS = ['system.hp', 'system.attributes.hp'];

function hpPath(actor: Obj): string {
  const p = HP_PATHS.find((path) => typeof getPath(actor, `${path}.value`) === 'number');
  if (!p) {
    throw new GmToolError('Actor has no recognisable HP field (system.hp or system.attributes.hp)');
  }
  return p;
}

/** Resolve actor or (unlinked) token target for HP / effect changes. */
function target(
  client: FoundryClient,
  args: Obj,
): {
  actor: ActorObj;
  token?: Obj & { _id: string };
  sceneId?: string;
  unlinked: boolean;
} {
  const tokenId = str(args, 'tokenId', false);
  if (tokenId) {
    const { token, scene } = locateToken(client, tokenId, str(args, 'sceneId', false));
    const actor = getActor(client, String(token.actorId));
    return { actor, token, sceneId: scene._id, unlinked: !token.actorLink };
  }
  const actorId = str(args, 'actorId', false);
  if (!actorId) {
    throw new GmToolError('Pass tokenId or actorId');
  }
  return { actor: getActor(client, actorId), unlinked: false };
}

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

// ---------------------------------------------------------------------------
// OSE system rolls
// ---------------------------------------------------------------------------

const OSE_SAVES = ['death', 'wand', 'paralysis', 'breath', 'spell'];
const OSE_SCORES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];

export function oseCheck(
  actor: Obj,
  kind: string,
  key: string | undefined,
  opts: { targetAc?: number; modifier?: number; attackType?: string },
): { formula: string; label: string; evaluate: (total: number, natural: number) => string } {
  const sys = (actor.system ?? {}) as Obj;
  const mod = opts.modifier ?? 0;
  const modStr = mod ? (mod > 0 ? ` + ${mod}` : ` - ${-mod}`) : '';
  if (kind === 'save') {
    if (!key || !OSE_SAVES.includes(key)) {
      throw new GmToolError(`save key must be one of ${OSE_SAVES.join(', ')}`);
    }
    const tgt = Number(getPath(sys, `saves.${key}.value`));
    return {
      formula: `1d20${modStr}`,
      label: `Save vs ${key} (target ${tgt})`,
      evaluate: (total) => (total >= tgt ? 'SUCCESS' : 'FAILURE'),
    };
  }
  if (kind === 'ability') {
    if (!key || !OSE_SCORES.includes(key)) {
      throw new GmToolError(`ability key must be one of ${OSE_SCORES.join(', ')}`);
    }
    const score = Number(getPath(sys, `scores.${key}.value`));
    return {
      formula: `1d20${modStr}`,
      label: `${key.toUpperCase()} check (roll ≤ ${score})`,
      evaluate: (total, nat) =>
        nat === 20
          ? 'FAILURE (natural 20)'
          : nat === 1
            ? 'SUCCESS (natural 1)'
            : total <= score
              ? 'SUCCESS'
              : 'FAILURE',
    };
  }
  if (kind === 'attack') {
    const thac0 = Number(getPath(sys, 'thac0.value') ?? 19);
    const type = opts.attackType === 'missile' ? 'missile' : 'melee';
    const typeMod = Number(getPath(sys, `thac0.mod.${type}`) ?? 0);
    const scoreBonus = Number(
      getPath(sys, `scores.${type === 'missile' ? 'dex' : 'str'}.mod`) ?? 0,
    );
    const totalMod = mod + typeMod + scoreBonus;
    const ms = totalMod ? (totalMod > 0 ? ` + ${totalMod}` : ` - ${-totalMod}`) : '';
    const ac = opts.targetAc;
    return {
      formula: `1d20${ms}`,
      label: `${type} attack (THAC0 ${thac0}${ac !== undefined ? ` vs AC ${ac}` : ''})`,
      evaluate: (total, nat) => {
        if (nat === 1) {
          return 'MISS (natural 1)';
        }
        if (nat === 20) {
          return 'HIT (natural 20)';
        }
        if (ac === undefined) {
          return `hits AC ${thac0 - total} or worse`;
        }
        return total >= thac0 - ac ? 'HIT' : 'MISS';
      },
    };
  }
  if (kind === 'morale') {
    const morale = Number(getPath(sys, 'details.morale') ?? 0);
    return {
      formula: `2d6${modStr}`,
      label: `Morale (${morale})`,
      evaluate: (total) => (total > morale ? 'FLEES / SURRENDERS' : 'STANDS'),
    };
  }
  if (kind === 'hitdice') {
    const hd = String(getPath(sys, 'hp.hd') ?? '1d8');
    return { formula: hd, label: `Hit dice (${hd})`, evaluate: (total) => `${total} HP` };
  }
  throw new GmToolError('kind must be save, ability, attack, morale or hitdice');
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const playTools: GmToolSpec[] = [
  {
    name: 'post_chat',
    description:
      'Post a chat message: GM narration (default), in character as a token/actor (style ic), an emote, or a whisper to specific users. Content may be HTML.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        style: {
          type: 'string',
          enum: ['narration', 'ic', 'ooc', 'emote'],
          description: 'default narration',
        },
        tokenId: { type: 'string', description: 'Speak as this token' },
        actorId: { type: 'string', description: 'Speak as this actor' },
        alias: { type: 'string', description: 'Speaker name override' },
        sceneId: { type: 'string' },
        whisperTo: {
          type: 'array',
          items: { type: 'string' },
          description: 'User ids/names; omit for public',
        },
      },
      required: ['content'],
    },
    async run(client, args) {
      const style = str(args, 'style', false) ?? 'narration';
      const styleNum = { narration: 0, ooc: 1, ic: 2, emote: 3 }[style];
      if (styleNum === undefined) {
        throw new GmToolError('style must be narration, ic, ooc or emote');
      }
      const w = world(client);
      let content = str(args, 'content') as string;
      if (style === 'narration' && !/^\s*</.test(content)) {
        content = `<p><em>${content}</em></p>`;
      }
      const whisper = resolveUserIds(client, strList(args, 'whisperTo'));
      const msg: Obj = {
        author: w.userId,
        speaker: speakerFor(client, args),
        content,
        style: styleNum,
      };
      if (whisper.length) {
        msg.whisper = whisper;
      }
      const res = (await client.gmModify('ChatMessage', 'create', { data: [msg] })) as Obj[];
      return ok(
        `💬 Posted ${whisper.length ? `whisper to ${whisper.length} user(s)` : style} message (${res[0]?._id})`,
      );
    },
  },

  {
    name: 'read_chat',
    description:
      'Read recent chat (newest last) including player messages, whispers and roll results (formula, total, dice). Use sinceId to fetch only messages after one you have seen.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Default 20, max 100' },
        sinceId: { type: 'string', description: 'Only messages after this message id' },
        playersOnly: { type: 'boolean', description: 'Skip messages authored by GMs/assistants' },
      },
    },
    async run(client, args) {
      const w = world(client);
      const users = w.users ?? [];
      let msgs = (w.messages ?? []) as unknown as Obj[];
      const since = str(args, 'sinceId', false);
      if (since) {
        const i = msgs.findIndex((m) => m._id === since);
        msgs = i >= 0 ? msgs.slice(i + 1) : msgs;
      }
      const authorOf = (m: Obj): Obj | undefined =>
        users.find((u) => u._id === (m.author ?? m.user)) as unknown as Obj | undefined;
      if (bool(args, 'playersOnly', false)) {
        msgs = msgs.filter((m) => Number(authorOf(m)?.role ?? 0) < 3);
      }
      const limit = Math.min(num(args, 'limit', false) ?? 20, 100);
      const rows = msgs.slice(-limit).map((m) => {
        const rolls = ((m.rolls as unknown[]) ?? []).map((r) => {
          try {
            const o = (typeof r === 'string' ? JSON.parse(r) : r) as Obj;
            const dice = ((o.terms as Obj[]) ?? [])
              .filter((t) => Array.isArray(t.results))
              .map((t) => `d${t.faces}:[${(t.results as Obj[]).map((x) => x.result).join(',')}]`);
            return { formula: o.formula, total: o.total, dice: dice.join(' ') };
          } catch {
            return { raw: String(r).slice(0, 100) };
          }
        });
        const whisper = (m.whisper as string[]) ?? [];
        return {
          id: m._id,
          time: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : undefined,
          author: authorOf(m)?.name,
          speaker: (m.speaker as Obj)?.alias,
          flavor: m.flavor ? stripHtml(m.flavor, 200) : undefined,
          text: stripHtml(m.content, 500),
          ...(whisper.length
            ? { whisperTo: whisper.map((id) => users.find((u) => u._id === id)?.name ?? id) }
            : {}),
          ...(m.blind ? { blind: true } : {}),
          ...(rolls.length ? { rolls } : {}),
        };
      });
      return ok(`💬 ${rows.length} message(s)`, rows);
    },
  },

  {
    name: 'gm_roll',
    description:
      'Roll a dice formula (e.g. "1d20", "2d6+1", "3d6-2") and post the roll to chat publicly, to GMs only, or blind. Returns the total and individual dice.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        formula: { type: 'string' },
        flavor: { type: 'string', description: 'Label shown above the roll' },
        ...rollModeProp,
        tokenId: { type: 'string', description: 'Roll as this token' },
        actorId: { type: 'string', description: 'Roll as this actor' },
      },
      required: ['formula'],
    },
    async run(client, args) {
      const formula = str(args, 'formula') as string;
      const mode = (str(args, 'mode', false) ?? 'public') as RollMode;
      const { result, messageId } = await postRoll(
        client,
        formula,
        str(args, 'flavor', false) ?? '',
        mode,
        speakerFor(client, args),
      );
      return ok(`🎲 ${formula} = **${result.total}** (${result.breakdown}) [${mode}]`, {
        total: result.total,
        breakdown: result.breakdown,
        messageId,
      });
    },
  },

  {
    name: 'system_roll',
    description:
      'OSE rules roll for an actor, posted to chat with the verdict: save (death|wand|paralysis|breath|spell, d20 ≥ target), ability check (str…cha, d20 ≤ score), attack (THAC0 vs targetAc, melee|missile), morale (2d6 > morale = flee), hitdice. Computed by the bridge from the actor sheet (the OSE client API is not reachable over the socket).' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: 'Actor id or name' },
        tokenId: { type: 'string', description: 'Or a token (uses its actor)' },
        kind: { type: 'string', enum: ['save', 'ability', 'attack', 'morale', 'hitdice'] },
        key: { type: 'string', description: 'save type or ability (str|int|wis|dex|con|cha)' },
        targetAc: { type: 'number', description: 'attack: descending AC of the target' },
        attackType: { type: 'string', enum: ['melee', 'missile'] },
        modifier: { type: 'number' },
        ...rollModeProp,
      },
      required: ['kind'],
    },
    async run(client, args) {
      const { actor, token } = target(client, args);
      const opts: { targetAc?: number; modifier?: number; attackType?: string } = {};
      const ac = num(args, 'targetAc', false);
      if (ac !== undefined) {
        opts.targetAc = ac;
      }
      const m = num(args, 'modifier', false);
      if (m !== undefined) {
        opts.modifier = m;
      }
      const at = str(args, 'attackType', false);
      if (at) {
        opts.attackType = at;
      }
      const chk = oseCheck(actor, str(args, 'kind') as string, str(args, 'key', false), opts);
      const pre = evaluateDiceFormula(chk.formula);
      const natural = pre.terms.find((t) => t.kind === 'dice')?.rolls?.[0] ?? 0;
      const verdict = chk.evaluate(pre.total, natural);
      const name = token?.name ?? actor.name;
      const speaker = token
        ? speakerFor(client, { tokenId: token._id })
        : { actor: actor._id, alias: actor.name };
      // Post exactly the pre-evaluated result so chat and verdict agree.
      const w = world(client);
      const mode = (str(args, 'mode', false) ?? 'public') as RollMode;
      const msg: Obj = {
        author: w.userId,
        speaker,
        flavor: `${chk.label}`,
        content: `<p><strong>${pre.total}</strong> — ${verdict}</p>`,
        rolls: [JSON.stringify(toFoundryRoll(chk.formula, pre))],
        sound: 'sounds/dice.wav',
      };
      if (mode !== 'public') {
        msg.whisper = mode === 'self' ? [w.userId] : gmUserIds(client);
      }
      if (mode === 'blind') {
        msg.blind = true;
      }
      await client.gmModify('ChatMessage', 'create', { data: [msg] });
      return ok(`🎲 ${name}: ${chk.label} → ${pre.total} (${pre.breakdown}) — ${verdict}`, {
        total: pre.total,
        natural,
        verdict,
      });
    },
  },

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
        formula: { type: 'string', description: 'Initiative formula, default 1d6 (OSE)' },
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
      const formula = str(args, 'formula', false) ?? '1d6';
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
        formula: { type: 'string', description: 'Default 1d6 (OSE)' },
        rerollAll: { type: 'boolean' },
      },
    },
    async run(client, args) {
      const c = getCombat(client, str(args, 'combatId', false));
      const ids = strList(args, 'combatantIds');
      const formula = str(args, 'formula', false) ?? '1d6';
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

  {
    name: 'apply_damage',
    description:
      'Change HP: positive amount = damage, negative = healing, or set=N for an exact value. Clamped to 0..max. Works on linked actors and unlinked tokens (token delta).' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        actorId: { type: 'string' },
        sceneId: { type: 'string' },
        amount: { type: 'number', description: 'Damage (negative heals)' },
        set: { type: 'number', description: 'Set HP to exactly this' },
      },
    },
    async run(client, args) {
      const t = target(client, args);
      const path = hpPath(t.actor);
      const delta = (t.token?.delta ?? {}) as Obj;
      const max = Number(
        getPath(delta, `${path}.max`) ?? getPath(t.actor, `${path}.max`) ?? Infinity,
      );
      const cur = Number(
        (t.unlinked ? getPath(delta, `${path}.value`) : undefined) ??
          getPath(t.actor, `${path}.value`),
      );
      const set = num(args, 'set', false);
      const amount = num(args, 'amount', false);
      if (set === undefined && amount === undefined) {
        throw new GmToolError('Pass amount or set');
      }
      const next = Math.max(0, Math.min(max, set ?? cur - (amount as number)));
      if (t.unlinked && t.token && t.sceneId) {
        await client.gmModify('Token', 'update', {
          updates: [{ _id: t.token._id, [`delta.${path}.value`]: next }],
          parentUuid: `Scene.${t.sceneId}`,
          diff: true,
        });
      } else {
        await client.gmModify('Actor', 'update', {
          updates: [{ _id: t.actor._id, [`${path}.value`]: next }],
          diff: true,
        });
      }
      const name = t.token?.name ?? t.actor.name;
      return ok(
        `❤️ ${name}: ${cur} → ${next}/${Number.isFinite(max) ? max : '?'}${next === 0 ? ' (down!)' : ''}`,
        { before: cur, after: next, max },
      );
    },
  },

  {
    name: 'set_condition',
    description:
      'Add or remove a condition / status effect (e.g. "dead", "prone", "blind", "poison") on an actor or token as an ActiveEffect with that status id. Lists current statuses.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        actorId: { type: 'string' },
        sceneId: { type: 'string' },
        statusId: { type: 'string' },
        active: { type: 'boolean' },
        label: { type: 'string', description: 'Display name (default statusId)' },
        icon: { type: 'string', description: 'Icon path (default icons/svg/aura.svg)' },
      },
      required: ['statusId', 'active'],
    },
    async run(client, args) {
      const t = target(client, args);
      const statusId = str(args, 'statusId') as string;
      const active = bool(args, 'active') as boolean;
      if (t.unlinked && t.token) {
        throw new GmToolError(
          'Token is unlinked: conditions on token deltas are not supported yet — use the actor (actorId) or link the token',
        );
      }
      const effects = embedded(t.actor, 'effects');
      const existing = effects.filter((e) => ((e.statuses as string[]) ?? []).includes(statusId));
      const parentUuid = `Actor.${t.actor._id}`;
      if (active && !existing.length) {
        await client.gmModify('ActiveEffect', 'create', {
          parentUuid,
          data: [
            {
              name: str(args, 'label', false) ?? statusId,
              img: str(args, 'icon', false) ?? 'icons/svg/aura.svg',
              statuses: [statusId],
            },
          ],
        });
      } else if (!active && existing.length) {
        await client.gmModify('ActiveEffect', 'delete', {
          parentUuid,
          ids: existing.map((e) => String(e._id)),
        });
      }
      const now = embedded(getActor(client, t.actor._id), 'effects').flatMap(
        (e) => (e.statuses as string[]) ?? [],
      );
      return ok(`🩹 ${t.actor.name}: ${statusId} ${active ? 'on' : 'off'}`, { statuses: now });
    },
  },

  {
    name: 'adjust_item_quantity',
    description:
      'Change the quantity of an item an actor owns (ammo, rations, coins — OSE currency is treasure items like "Gold Pieces"). delta adds/subtracts; creates nothing; use create_actor_item to add new items.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string' },
        item: { type: 'string', description: 'Item id or name' },
        delta: { type: 'number' },
        set: { type: 'number' },
        deleteAtZero: { type: 'boolean' },
      },
      required: ['actorId', 'item'],
    },
    async run(client, args) {
      const actor = getActor(client, str(args, 'actorId') as string);
      const item = findByIdOrName(
        embedded(actor, 'items') as Array<Obj & { _id: string; name?: string }>,
        str(args, 'item') as string,
        'Item',
      );
      const q = getPath(item, 'system.quantity');
      const path =
        typeof q === 'object' && q !== null ? 'system.quantity.value' : 'system.quantity';
      const cur = Number(getPath(item, path) ?? 0);
      const set = num(args, 'set', false);
      const delta = num(args, 'delta', false);
      if (set === undefined && delta === undefined) {
        throw new GmToolError('Pass delta or set');
      }
      const next = Math.max(0, set ?? cur + (delta as number));
      if (next === 0 && bool(args, 'deleteAtZero', false)) {
        await client.gmModify('Item', 'delete', {
          ids: [item._id],
          parentUuid: `Actor.${actor._id}`,
        });
        return ok(`🎒 ${actor.name}: ${item.name} used up (deleted)`);
      }
      await client.gmModify('Item', 'update', {
        updates: [{ _id: item._id, [path]: next }],
        parentUuid: `Actor.${actor._id}`,
        diff: true,
      });
      return ok(`🎒 ${actor.name}: ${item.name} ${cur} → ${next}`);
    },
  },

  {
    name: 'share_journal',
    description:
      'Show a journal entry or page to players (pops it open on their screens), or share an image URL/path. Defaults to all players.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: { type: 'string', description: 'Journal entry id or name' },
        pageId: { type: 'string', description: 'Page id or name within the entry' },
        image: { type: 'string', description: 'Share this image instead (path or URL)' },
        title: { type: 'string' },
        userIds: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(client, args) {
      const users = resolveUserIds(client, strList(args, 'userIds'));
      const image = str(args, 'image', false);
      if (image) {
        await client.gmEmit('shareImage', {
          image,
          title: str(args, 'title', false) ?? '',
          ...(users.length ? { users } : {}),
        });
        return ok(`🖼️ Shared image ${image}`);
      }
      const j = findByIdOrName(
        world(client).journal as unknown as Array<Obj & { _id: string; name: string }>,
        str(args, 'journalId') as string,
        'JournalEntry',
      );
      let uuid = `JournalEntry.${j._id}`;
      const pageKey = str(args, 'pageId', false);
      let label = j.name;
      if (pageKey) {
        const p = findByIdOrName(
          embedded(j, 'pages') as Array<Obj & { _id: string; name?: string }>,
          pageKey,
          'Page',
        );
        uuid += `.JournalEntryPage.${p._id}`;
        label += ` › ${p.name}`;
      }
      await client.gmEmit('showEntry', uuid, { force: true, ...(users.length ? { users } : {}) });
      return ok(`📖 Showed "${label}" to ${users.length || 'all'} player(s)`, { uuid });
    },
  },

  {
    name: 'control_audio',
    description:
      'Play or stop a playlist (all its tracks per its mode) or a single track, or turn a scene ambient sound on/off.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'stop'] },
        playlist: { type: 'string', description: 'Playlist id or name' },
        track: { type: 'string', description: 'Track (PlaylistSound) id or name' },
        ambientSoundId: {
          type: 'string',
          description: 'Scene AmbientSound id (instead of playlist)',
        },
        sceneId: { type: 'string' },
      },
      required: ['action'],
    },
    async run(client, args) {
      const play = str(args, 'action') === 'play';
      const amb = str(args, 'ambientSoundId', false);
      if (amb) {
        const scene = getScene(client, str(args, 'sceneId', false));
        await client.gmModify('AmbientSound', 'update', {
          updates: [{ _id: amb, hidden: !play }],
          parentUuid: `Scene.${scene._id}`,
        });
        return ok(`🔊 Ambient sound ${amb} ${play ? 'on' : 'off'}`);
      }
      const pl = findByIdOrName(
        ((world(client) as unknown as Obj).playlists ?? []) as Array<
          Obj & { _id: string; name: string }
        >,
        str(args, 'playlist') as string,
        'Playlist',
      );
      const sounds = embedded(pl, 'sounds') as Array<Obj & { _id: string; name?: string }>;
      const trackKey = str(args, 'track', false);
      let chosen = sounds;
      if (trackKey) {
        chosen = [findByIdOrName(sounds, trackKey, 'Track')];
      } else if (play && pl.mode !== 1) {
        chosen = sounds.slice(0, 1); // sequential/shuffle: start with the first track
      }
      if (!play && !trackKey) {
        chosen = sounds.filter((s) => s.playing);
      }
      if (chosen.length) {
        await client.gmModify('PlaylistSound', 'update', {
          updates: chosen.map((s) => ({
            _id: s._id,
            playing: play,
            ...(play ? { pausedTime: 0 } : {}),
          })),
          parentUuid: `Playlist.${pl._id}`,
        });
      }
      const anyPlaying = play || sounds.some((s) => s.playing && !chosen.includes(s));
      await client.gmModify('Playlist', 'update', {
        updates: [{ _id: pl._id, playing: anyPlaying }],
      });
      return ok(
        `🎵 ${play ? 'Playing' : 'Stopped'} ${pl.name}${chosen.length ? `: ${chosen.map((s) => s.name).join(', ')}` : ''}`,
      );
    },
  },

  {
    name: 'list_party',
    description:
      'List users with role, online status and assigned character (actor) — who is playing whom.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      const w = world(client);
      const online = new Set((w as unknown as { activeUsers?: string[] }).activeUsers ?? []);
      const actors = w.actors as unknown as Obj[];
      const roles = ['none', 'player', 'trusted', 'assistant GM', 'gamemaster'];
      const rows = (w.users ?? []).map((u) => ({
        id: u._id,
        name: u.name,
        role: roles[u.role ?? 0] ?? String(u.role),
        online: online.has(u._id),
        character: u.character
          ? { id: u.character, name: actors.find((a) => a._id === u.character)?.name }
          : null,
      }));
      return ok(`👥 ${rows.filter((r) => r.online).length}/${rows.length} online`, rows);
    },
  },

  {
    name: 'import_from_compendium',
    description:
      'Import an Actor/Item/JournalEntry/RollTable from a compendium pack into the world (by entry id or name), optionally placing an actor as a token on a scene.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'Pack id, e.g. "ose.monsters" or "world.my-pack"' },
        entry: { type: 'string', description: 'Entry id or name' },
        folder: { type: 'string', description: 'World folder id' },
        place: {
          type: 'object',
          description: 'Actors only: place a token',
          properties: {
            sceneId: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            hidden: { type: 'boolean' },
          },
        },
        reuseExisting: {
          type: 'boolean',
          description: 'Reuse a world actor already imported from this entry (default true)',
        },
      },
      required: ['pack', 'entry'],
    },
    async run(client, args) {
      const pack = str(args, 'pack') as string;
      const w = world(client);
      const meta = ((w as unknown as Obj).packs as Obj[] | undefined)?.find(
        (p) => p.id === pack || `${p.packageName}.${p.name}` === pack,
      );
      const type = String(meta?.type ?? meta?.documentName ?? 'Actor');
      const key = str(args, 'entry') as string;
      const index = (await client.gmGet(type, {
        pack,
        index: true,
        indexFields: ['name'],
      })) as Array<Obj & { _id: string; name: string }>;
      const hit = findByIdOrName(index, key, `${pack} entry`);
      const uuid = `Compendium.${pack}.${type}.${hit._id}`;
      const coll: Record<string, string> = {
        Actor: 'actors',
        Item: 'items',
        JournalEntry: 'journal',
        RollTable: 'tables',
      };
      const existing = bool(args, 'reuseExisting', true)
        ? (((w as unknown as Obj)[coll[type] ?? ''] as Obj[]) ?? []).find(
            (d) =>
              getPath(d, '_stats.compendiumSource') === uuid ||
              getPath(d, 'flags.core.sourceId') === uuid,
          )
        : undefined;
      let doc = existing;
      if (!doc) {
        const [src] = (await client.gmGet(type, { pack, query: { _id: hit._id } })) as Obj[];
        if (!src) {
          throw new GmToolError(`Could not load ${uuid}`);
        }
        const data = structuredClone(src);
        delete data._id;
        data._stats = { compendiumSource: uuid };
        const folder = str(args, 'folder', false);
        data.folder = folder ?? null;
        doc = ((await client.gmModify(type, 'create', { data: [data] })) as Obj[])[0];
      }
      if (!doc) {
        throw new GmToolError('Import failed');
      }
      let placed = '';
      const place = args.place as Obj | undefined;
      if (place && type === 'Actor') {
        const scene = getScene(client, str(place, 'sceneId', false));
        const proto = structuredClone((doc.prototypeToken ?? {}) as Obj);
        delete proto.randomImg;
        const [tok] = (await client.gmModify('Token', 'create', {
          parentUuid: `Scene.${scene._id}`,
          data: [
            {
              ...proto,
              name: proto.name ?? doc.name,
              actorId: doc._id,
              x: num(place, 'x'),
              y: num(place, 'y'),
              hidden: bool(place, 'hidden', false),
            },
          ],
        })) as Obj[];
        placed = ` and placed token ${tok?._id} on "${scene.name}"`;
      }
      return ok(
        `📦 ${existing ? 'Reused' : 'Imported'} ${type} "${doc.name}" (${doc._id})${placed}`,
        { id: doc._id, uuid },
      );
    },
  },

  {
    name: 'lookup_rule',
    description:
      'Search rules text: world journal pages and JournalEntry compendium packs (e.g. the OSE rules) by name and content. Returns matching pages with excerpts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        packs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit compendium search to these packs',
        },
        maxResults: { type: 'number', description: 'Default 5' },
      },
      required: ['query'],
    },
    async run(client, args) {
      const q = (str(args, 'query') as string).toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const max = num(args, 'maxResults', false) ?? 5;
      const w = world(client);
      const hits: Array<{
        score: number;
        source: string;
        entry: string;
        page: string;
        excerpt: string;
      }> = [];
      const scorePages = (source: string, entries: Obj[]): void => {
        for (const j of entries) {
          for (const p of embedded(j, 'pages')) {
            const text = stripHtml((p.text as Obj)?.content ?? '', 100000);
            const hay = `${j.name} ${p.name} ${text}`.toLowerCase();
            const title = `${j.name} ${p.name}`.toLowerCase();
            let score = 0;
            for (const word of words) {
              if (title.includes(word)) {
                score += 5;
              }
              if (hay.includes(word)) {
                score += 1;
              }
            }
            if (score > 0 && words.every((word) => hay.includes(word))) {
              const at = Math.max(0, text.toLowerCase().indexOf(words[0] ?? ''));
              hits.push({
                score,
                source,
                entry: String(j.name),
                page: String(p.name),
                excerpt: text.slice(Math.max(0, at - 200), at + 600),
              });
            }
          }
        }
      };
      scorePages('world', w.journal as unknown as Obj[]);
      const wanted = strList(args, 'packs');
      const packs = (((w as unknown as Obj).packs as Obj[]) ?? []).filter(
        (p) =>
          (p.type ?? p.documentName) === 'JournalEntry' &&
          (!wanted.length || wanted.includes(String(p.id))),
      );
      for (const p of packs.slice(0, 10)) {
        try {
          scorePages(String(p.id), (await client.gmGet('JournalEntry', { pack: p.id })) as Obj[]);
        } catch {
          // pack unreadable for this user — skip
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, max);
      if (!top.length) {
        return ok(
          `📚 No rules text matched "${q}" (searched world journals and ${packs.length} pack(s))`,
        );
      }
      return ok(
        `📚 ${top.length} match(es) for "${q}":\n\n${top.map((h) => `### ${h.entry} › ${h.page} [${h.source}]\n${h.excerpt}`).join('\n\n')}`,
      );
    },
  },
];

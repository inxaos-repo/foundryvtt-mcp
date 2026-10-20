/**
 * GM toolkit — chat, dice and system rolls.
 */

import type { FoundryClient } from '../../foundry/client.js';
import { type DiceFormulaResult, evaluateDiceFormula } from '../../foundry/dice-formula.js';
import {
  bool,
  GmToolError,
  getActor,
  getPath,
  gmUserIds,
  locateToken,
  num,
  type Obj,
  ok,
  resolveUserIds,
  str,
  stripHtml,
  strList,
  target,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './spec.js';

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

export const chatTools: GmToolSpec[] = [
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
];

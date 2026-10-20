/**
 * Old-School Essentials (system id `ose`). Saves succeed on d20 >= target,
 * ability checks on d20 <= score (natural 1 always succeeds, natural 20 always
 * fails), attacks hit when d20 + modifiers >= THAC0 - descending AC, and
 * morale fails on 2d6 above the morale score.
 */

import type { SystemCheck, SystemCheckOptions, SystemRollAdapter } from './types.js';

type Obj = Record<string, unknown>;

const getPath = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);

const OSE_SAVES = ['death', 'wand', 'paralysis', 'breath', 'spell'];
const OSE_SCORES = ['str', 'int', 'wis', 'dex', 'con', 'cha'];

function buildCheck(actor: Obj, kind: string, opts: SystemCheckOptions): SystemCheck {
  const key = opts.key;
  const sys = (actor.system ?? {}) as Obj;
  const mod = opts.modifier ?? 0;
  const modStr = mod ? (mod > 0 ? ` + ${mod}` : ` - ${-mod}`) : '';
  if (kind === 'save') {
    if (!key || !OSE_SAVES.includes(key)) {
      throw new Error(`save key must be one of ${OSE_SAVES.join(', ')}`);
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
      throw new Error(`ability key must be one of ${OSE_SCORES.join(', ')}`);
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
    const type = opts.variant === 'missile' ? 'missile' : 'melee';
    const typeMod = Number(getPath(sys, `thac0.mod.${type}`) ?? 0);
    const scoreBonus = Number(
      getPath(sys, `scores.${type === 'missile' ? 'dex' : 'str'}.mod`) ?? 0,
    );
    const totalMod = mod + typeMod + scoreBonus;
    const ms = totalMod ? (totalMod > 0 ? ` + ${totalMod}` : ` - ${-totalMod}`) : '';
    const ac = opts.target;
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
  throw new Error('kind must be save, ability, attack, morale or hitdice');
}

export const ose: SystemRollAdapter = {
  systemId: 'ose',
  initiativeFormula: '1d6',
  kinds: {
    save: 'key: death|wand|paralysis|breath|spell',
    ability: 'key: str|int|wis|dex|con|cha',
    attack: 'target: descending AC; variant: melee|missile',
    morale: '2d6 against the morale score',
    hitdice: 'roll the actor hit dice',
  },
  buildCheck,
};

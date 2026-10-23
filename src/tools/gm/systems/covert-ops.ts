/**
 * Covert Ops d20 (system id `covert-ops-d20`), a d20 espionage system.
 *
 * The headless bridge only sees stored (source) actor data, so every derived
 * value the system computes in prepareDerivedData (ability mods, skill/save
 * totals, Defense, attack bonuses) is recomputed here with the same formulas.
 * Checks are d20 + bonus; a natural roll at or above the threat range is a
 * threat, at or below the error range an error. Action dice add NdX to a roll.
 */

import type { SystemCheck, SystemCheckOptions, SystemRollAdapter } from './types.js';

type Obj = Record<string, unknown>;

export const COVERT_OPS_ID = 'covert-ops-d20';

export const COD_ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export const COD_SAVES: Record<string, string> = { fort: 'con', ref: 'dex', will: 'wis' };
export const COD_CHECKS: Record<string, string> = {
  knowledge: 'int',
  request: 'cha',
  gear: 'wis',
};

const getPath = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), obj);

const n = (v: unknown, d = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
};

export const abilityMod = (score: unknown): number => Math.floor((n(score) - 10) / 2);

const signed = (m: number): string => (m ? (m > 0 ? ` + ${m}` : ` - ${-m}`) : '');

/** Derived numbers for an actor, computed from its stored system data. */
export function covertOpsSummary(actor: Obj): Obj {
  const sys = (actor.system ?? {}) as Obj;
  const mod = (a: string): number => abilityMod(getPath(sys, `abilities.${a}.value`) ?? 10);
  const abilities = Object.fromEntries(
    COD_ABILITIES.map((a) => [
      a,
      { score: n(getPath(sys, `abilities.${a}.value`), 10), mod: mod(a) },
    ]),
  );
  const skills: Obj = {};
  for (const [key, raw] of Object.entries((sys.skills ?? {}) as Record<string, Obj>)) {
    const ability = String(raw.ability ?? 'int');
    skills[key] = {
      total: Math.floor(n(raw.ranks)) + mod(ability) + n(raw.misc),
      ranks: n(raw.ranks),
      ability,
      ...(raw.focus ? { focus: raw.focus } : {}),
      threat: n(raw.threat, 20),
      error: n(raw.error, 1),
    };
  }
  const saves = Object.fromEntries(
    Object.entries(COD_SAVES).map(([k, a]) => [
      k,
      n(getPath(sys, `saves.${k}.base`)) + mod(a) + n(getPath(sys, `saves.${k}.misc`)),
    ]),
  );
  const bab = n(sys.bab);
  const level = n(sys.level, 1);
  return {
    name: actor.name,
    type: actor.type,
    level,
    className: sys.className ?? '',
    abilities,
    skills,
    saves,
    defense:
      10 + n(getPath(sys, 'defense.classBonus')) + mod('dex') + n(getPath(sys, 'defense.misc')),
    initiative:
      n(getPath(sys, 'initiative.classBonus')) + mod('dex') + n(getPath(sys, 'initiative.misc')),
    bab,
    attack: { melee: bab + mod('str'), ranged: bab + mod('dex') },
    attackRange: {
      threat: n(getPath(sys, 'attackRange.threat'), 20),
      error: n(getPath(sys, 'attackRange.error'), 1),
    },
    checks: Object.fromEntries(Object.entries(COD_CHECKS).map(([k, a]) => [k, level + mod(a)])),
    vitality: {
      value: n(getPath(sys, 'vitality.value')),
      max: n(getPath(sys, 'vitality.max')),
    },
    wounds: { value: n(getPath(sys, 'wounds.value')), max: n(getPath(sys, 'wounds.max')) },
    actionDice: {
      value: n(getPath(sys, 'actionDice.value')),
      die: n(getPath(sys, 'actionDice.die'), 4),
    },
  };
}

/** Verdict text for a d20 check with threat/error ranges and an optional DC. */
export function codVerdict(
  total: number,
  natural: number,
  threat: number,
  error: number,
  dc?: number,
): string {
  const parts: string[] = [];
  if (dc !== undefined) {
    parts.push(total >= dc ? 'SUCCESS' : 'FAILURE');
  }
  if (natural >= threat) {
    parts.push(`THREAT (natural ${natural})`);
  } else if (error > 0 && natural <= error) {
    parts.push(`ERROR (natural ${natural})`);
  }
  return parts.length ? parts.join(', ') : `total ${total}`;
}

function buildCheck(actor: Obj, kind: string, opts: SystemCheckOptions): SystemCheck {
  const s = covertOpsSummary(actor) as {
    abilities: Record<string, { mod: number }>;
    skills: Record<string, { total: number; threat: number; error: number; focus?: string }>;
    saves: Record<string, number>;
    attack: { melee: number; ranged: number };
    attackRange: { threat: number; error: number };
    initiative: number;
    checks: Record<string, number>;
  };
  const key = opts.key;
  const mod = opts.modifier ?? 0;
  const dc = opts.target;
  const vs = dc !== undefined ? ` vs ${kind === 'attack' ? 'Defense' : 'DC'} ${dc}` : '';
  const make = (label: string, bonus: number, threat = 20, error = 1): SystemCheck => ({
    formula: `1d20${signed(bonus + mod)}`,
    label: `${label}${vs}`,
    evaluate: (total, nat) => codVerdict(total, nat, threat, error, dc),
  });
  if (kind === 'skill') {
    const sk = key ? s.skills[key] : undefined;
    if (!key || !sk) {
      throw new Error(`skill key must be one of ${Object.keys(s.skills).join(', ')}`);
    }
    return make(`${key}${sk.focus ? ` (${sk.focus})` : ''}`, sk.total, sk.threat, sk.error);
  }
  if (kind === 'save') {
    if (!key || !(key in COD_SAVES)) {
      throw new Error(`save key must be one of ${Object.keys(COD_SAVES).join(', ')}`);
    }
    return make(`${key} save`, s.saves[key] ?? 0);
  }
  if (kind === 'ability') {
    if (!key || !(key in s.abilities)) {
      throw new Error(`ability key must be one of ${COD_ABILITIES.join(', ')}`);
    }
    return make(`${key.toUpperCase()} check`, s.abilities[key]?.mod ?? 0);
  }
  if (kind === 'attack') {
    const type = opts.variant === 'ranged' ? 'ranged' : 'melee';
    return make(`${type} attack`, s.attack[type], s.attackRange.threat, s.attackRange.error);
  }
  if (kind === 'initiative') {
    return make('Initiative', s.initiative);
  }
  if (kind === 'check') {
    if (!key || !(key in COD_CHECKS)) {
      throw new Error(`check key must be one of ${Object.keys(COD_CHECKS).join(', ')}`);
    }
    return make(`${key} check`, s.checks[key] ?? 0);
  }
  throw new Error('kind must be skill, save, ability, attack, initiative or check');
}

export const covertOps: SystemRollAdapter = {
  systemId: COVERT_OPS_ID,
  initiativeFormula: '1d20',
  initiativeBonus: (actor) => Number(covertOpsSummary(actor).initiative) || 0,
  kinds: {
    skill: 'key: skill id (e.g. notice, sneak, senseMotive); target: DC',
    save: 'key: fort|ref|will; target: DC',
    ability: 'key: str|dex|con|int|wis|cha; target: DC',
    attack: 'variant: melee|ranged; target: defender Defense',
    initiative: 'initiative check',
    check: 'key: knowledge|request|gear (level + ability); target: DC',
  },
  actionDie: (actor) => {
    const s = covertOpsSummary(actor) as { actionDice: { value: number; die: number } };
    return { ...s.actionDice, path: 'system.actionDice.value' };
  },
  buildCheck,
};

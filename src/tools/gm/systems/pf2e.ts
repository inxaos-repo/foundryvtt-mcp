/**
 * Pathfinder Second Edition (system id "pf2e") adapter.
 *
 * The bridge sees *source* data, not the prepared data the PF2e system builds
 * in the browser. NPCs store their final numbers (saves, perception, skills),
 * so NPC checks are exact. Player characters store only choices, so their
 * modifiers are rebuilt here from attribute boosts and proficiency ranks:
 * attribute modifier + proficiency (2 × rank + level when trained). Item,
 * status and circumstance bonuses, feats and rule elements are not applied;
 * pass `modifier` to add them.
 *
 * Degrees of success follow the core rules: beat the DC by 10 for a critical
 * success, miss by 10 for a critical failure, and a natural 20 / natural 1
 * moves the result one step up / down.
 */

import { GmToolError } from '../helpers.js';
import type { SystemCheck, SystemCheckOptions, SystemRollAdapter } from './types.js';

type Obj = Record<string, unknown>;
type Attr = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
const ATTRS: readonly Attr[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

const SAVES: Record<string, Attr> = { fortitude: 'con', reflex: 'dex', will: 'wis' };
const SAVE_ALIASES: Record<string, string> = {
  fort: 'fortitude',
  fortitude: 'fortitude',
  con: 'fortitude',
  ref: 'reflex',
  reflex: 'reflex',
  dex: 'reflex',
  will: 'will',
  wis: 'will',
};

export const PF2E_SKILLS: Record<string, Attr> = {
  acrobatics: 'dex',
  arcana: 'int',
  athletics: 'str',
  crafting: 'int',
  deception: 'cha',
  diplomacy: 'cha',
  intimidation: 'cha',
  medicine: 'wis',
  nature: 'wis',
  occultism: 'int',
  performance: 'cha',
  religion: 'wis',
  society: 'int',
  stealth: 'dex',
  survival: 'wis',
  thievery: 'dex',
};
const SKILL_ALIASES: Record<string, string> = {
  acr: 'acrobatics',
  arc: 'arcana',
  ath: 'athletics',
  cra: 'crafting',
  dec: 'deception',
  dip: 'diplomacy',
  itm: 'intimidation',
  intimidate: 'intimidation',
  med: 'medicine',
  nat: 'nature',
  occ: 'occultism',
  prf: 'performance',
  perform: 'performance',
  rel: 'religion',
  soc: 'society',
  ste: 'stealth',
  sur: 'survival',
  thi: 'thievery',
};

/** Conditions in the pf2e.conditionitems compendium that carry a value. */
export const PF2E_VALUED_CONDITIONS = [
  'clumsy',
  'cursebound',
  'doomed',
  'drained',
  'dying',
  'enfeebled',
  'frightened',
  'sickened',
  'slowed',
  'stunned',
  'stupefied',
  'wounded',
] as const;

const RANKS = ['untrained', 'trained', 'expert', 'master', 'legendary'];

function get(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], o);
}
function numAt(o: unknown, path: string): number | undefined {
  const v = get(o, path);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function items(actor: Obj): Obj[] {
  return Array.isArray(actor.items) ? (actor.items as Obj[]) : [];
}
function itemOfType(actor: Obj, type: string): Obj | undefined {
  return items(actor).find((i) => i.type === type);
}
function signed(n: number): string {
  return n >= 0 ? `+ ${n}` : `- ${Math.abs(n)}`;
}

/** The attribute picked in one boost slot ({value:[...], selected?}). */
function boostChoice(slot: unknown): Attr | undefined {
  const s = slot as { selected?: unknown; value?: unknown } | undefined;
  if (typeof s?.selected === 'string' && ATTRS.includes(s.selected as Attr)) {
    return s.selected as Attr;
  }
  const v = Array.isArray(s?.value) ? (s?.value as string[]) : [];
  return v.length === 1 && ATTRS.includes(v[0] as Attr) ? (v[0] as Attr) : undefined;
}
function slots(o: unknown): unknown[] {
  return o && typeof o === 'object' ? Object.values(o as Obj) : [];
}

/**
 * Character attribute modifiers rebuilt from boosts, in the order the rules
 * apply them: ancestry flaws and boosts, background, class key attribute, then
 * level boosts. A boost to a modifier of +4 or more only adds half (two such
 * partial boosts make +1).
 */
export function characterAttributes(actor: Obj): Record<Attr, number> {
  const stored = get(actor, 'system.abilities') as Record<string, Obj> | undefined;
  if (stored && ATTRS.every((a) => typeof stored[a]?.mod === 'number')) {
    return Object.fromEntries(ATTRS.map((a) => [a, stored[a]?.mod as number])) as Record<
      Attr,
      number
    >;
  }
  const level = numAt(actor, 'system.details.level.value') ?? 1;
  const mods = Object.fromEntries(ATTRS.map((a) => [a, 0])) as Record<Attr, number>;
  const partial = Object.fromEntries(ATTRS.map((a) => [a, 0])) as Record<Attr, number>;
  const boost = (a: Attr | undefined) => {
    if (!a) {
      return;
    }
    if (mods[a] >= 4) {
      partial[a]++;
      if (partial[a] === 2) {
        mods[a]++;
        partial[a] = 0;
      }
    } else {
      mods[a]++;
    }
  };
  const ancestry = itemOfType(actor, 'ancestry');
  const background = itemOfType(actor, 'background');
  const cls = itemOfType(actor, 'class');
  for (const f of slots(get(ancestry, 'system.flaws'))) {
    const a = boostChoice(f);
    if (a) {
      mods[a]--;
    }
  }
  for (const b of slots(get(ancestry, 'system.boosts'))) {
    boost(boostChoice(b));
  }
  for (const b of slots(get(background, 'system.boosts'))) {
    boost(boostChoice(b));
  }
  const key =
    boostChoice(get(cls, 'system.keyAbility')) ??
    (get(actor, 'system.details.keyability.value') as Attr | undefined);
  boost(ATTRS.includes(key as Attr) ? (key as Attr) : undefined);
  const levelBoosts = (get(actor, 'system.build.attributes.boosts') ?? {}) as Record<
    string,
    unknown
  >;
  for (const lvl of Object.keys(levelBoosts)
    .map(Number)
    .filter((l) => l <= level)
    .sort((x, y) => x - y)) {
    const list = levelBoosts[String(lvl)];
    for (const a of Array.isArray(list) ? list : []) {
      boost(ATTRS.includes(a as Attr) ? (a as Attr) : undefined);
    }
  }
  return mods;
}

function proficiency(rank: number, level: number): number {
  return rank > 0 ? 2 * rank + level : 0;
}

function loreItem(actor: Obj, key: string): Obj | undefined {
  const k = key.toLowerCase().replace(/\s+lore$/, '');
  return items(actor).find(
    (i) =>
      i.type === 'lore' &&
      String(i.name ?? '')
        .toLowerCase()
        .replace(/\s+lore$/, '') === k,
  );
}

interface Stat {
  label: string;
  mod: number;
  note?: string;
}

function npcStat(actor: Obj, kind: string, key: string): Stat {
  if (kind === 'save') {
    const v = numAt(actor, `system.saves.${key}.value`);
    if (v === undefined) {
      throw new GmToolError(`${actor.name} has no ${key} save value`);
    }
    return { label: `${key[0]?.toUpperCase()}${key.slice(1)} save`, mod: v };
  }
  if (kind === 'perception') {
    const v =
      numAt(actor, 'system.perception.mod') ?? numAt(actor, 'system.attributes.perception.value');
    if (v === undefined) {
      throw new GmToolError(`${actor.name} has no perception modifier`);
    }
    return { label: 'Perception', mod: v };
  }
  const skill = PF2E_SKILLS[key];
  if (skill) {
    const v =
      numAt(actor, `system.skills.${key}.base`) ?? numAt(actor, `system.skills.${key}.value`);
    if (v !== undefined) {
      return { label: titled(key), mod: v };
    }
    const lore = loreItem(actor, key);
    const lv = numAt(lore, 'system.mod.value');
    if (lv !== undefined) {
      return { label: titled(key), mod: lv };
    }
    return {
      label: titled(key),
      mod: numAt(actor, `system.abilities.${skill}.mod`) ?? 0,
      note: 'untrained',
    };
  }
  const lore = loreItem(actor, key);
  const lv = numAt(lore, 'system.mod.value');
  if (lv === undefined) {
    throw new GmToolError(`${actor.name} has no skill or lore "${key}"`);
  }
  return { label: String(lore?.name), mod: lv };
}

function characterStat(actor: Obj, kind: string, key: string): Stat {
  const level = numAt(actor, 'system.details.level.value') ?? 1;
  const attrs = characterAttributes(actor);
  const cls = itemOfType(actor, 'class');
  let attr: Attr;
  let rank: number;
  let label: string;
  if (kind === 'save') {
    attr = SAVES[key] as Attr;
    rank =
      numAt(actor, `system.saves.${key}.rank`) ?? numAt(cls, `system.savingThrows.${key}`) ?? 0;
    label = `${titled(key)} save`;
  } else if (kind === 'perception') {
    attr = 'wis';
    rank = numAt(actor, 'system.perception.rank') ?? numAt(cls, 'system.perception') ?? 0;
    label = 'Perception';
  } else if (PF2E_SKILLS[key]) {
    attr = PF2E_SKILLS[key] as Attr;
    const trainedBy = [cls, itemOfType(actor, 'background')].some((i) =>
      ((get(i, 'system.trainedSkills.value') as string[] | undefined) ?? []).includes(key),
    );
    rank = Math.max(numAt(actor, `system.skills.${key}.rank`) ?? 0, trainedBy ? 1 : 0);
    label = titled(key);
  } else {
    const lore = loreItem(actor, key);
    if (!lore) {
      throw new GmToolError(`${actor.name} has no skill or lore "${key}"`);
    }
    attr = 'int';
    rank = numAt(lore, 'system.proficient.value') ?? 0;
    label = String(lore.name);
  }
  const mod = attrs[attr] + proficiency(rank, level);
  return { label, mod, note: `${RANKS[rank] ?? `rank ${rank}`}, ${attr} ${attrs[attr]}` };
}

function titled(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function resolveKey(kind: string, key: string | undefined): string {
  if (kind === 'perception') {
    return 'perception';
  }
  const k = (key ?? '').trim().toLowerCase();
  if (!k) {
    throw new GmToolError(`${kind} needs a key`);
  }
  if (kind === 'save') {
    const s = SAVE_ALIASES[k];
    if (!s) {
      throw new GmToolError(`Unknown save "${key}". Use fortitude, reflex or will.`);
    }
    return s;
  }
  return SKILL_ALIASES[k] ?? k;
}

export type Degree = 'critical success' | 'success' | 'failure' | 'critical failure';
const DEGREES: Degree[] = ['critical failure', 'failure', 'success', 'critical success'];

/** PF2e degree of success for a d20 check against a DC. */
export function degreeOfSuccess(total: number, natural: number, dc: number): Degree {
  let step = total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1;
  if (natural === 20) {
    step = Math.min(3, step + 1);
  } else if (natural === 1) {
    step = Math.max(0, step - 1);
  }
  return DEGREES[step] as Degree;
}

export const pf2eAdapter: SystemRollAdapter = {
  systemId: 'pf2e',
  kinds: {
    save: 'Saving throw; key fortitude|reflex|will (fort/ref aliases). target = DC',
    skill:
      'Skill or lore check; key acrobatics…thievery (3-letter aliases) or a lore name. target = DC',
    perception: 'Perception check (no key). target = DC',
  },
  conditions: { pack: 'pf2e.conditionitems', valued: PF2E_VALUED_CONDITIONS },
  buildCheck(actor: Obj, kind: string, opts: SystemCheckOptions): SystemCheck {
    const key = resolveKey(kind, opts.key);
    const stat =
      actor.type === 'character' ? characterStat(actor, kind, key) : npcStat(actor, kind, key);
    const extra = opts.modifier ?? 0;
    const total = stat.mod + extra;
    const dc = opts.target;
    const label = `${stat.label} ${stat.mod >= 0 ? '+' : ''}${stat.mod}${extra ? ` ${signed(extra)}` : ''}${stat.note ? ` (${stat.note})` : ''}${dc !== undefined ? ` vs DC ${dc}` : ''}`;
    return {
      formula: total ? `1d20 ${signed(total)}` : '1d20',
      label,
      evaluate(rolled: number, natural: number): string {
        if (dc === undefined) {
          return natural === 20
            ? 'natural 20 (no DC)'
            : natural === 1
              ? 'natural 1 (no DC)'
              : 'no DC given';
        }
        return degreeOfSuccess(rolled, natural, dc);
      },
    };
  },
};

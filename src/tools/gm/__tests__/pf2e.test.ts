import { describe, expect, it } from 'vitest';
import { characterAttributes, degreeOfSuccess, pf2eAdapter } from '../systems/pf2e.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

// Shapes follow PF2e 8.x source data (what the server sends, before the
// browser prepares derived values).
const npc = () => ({
  _id: ID(2),
  name: 'Archer',
  type: 'npc',
  system: {
    details: { level: { value: 4 } },
    abilities: {
      str: { mod: 2 },
      dex: { mod: 4 },
      con: { mod: 2 },
      int: { mod: 0 },
      wis: { mod: 2 },
      cha: { mod: -1 },
    },
    saves: { fortitude: { value: 10 }, reflex: { value: 12 }, will: { value: 8 } },
    perception: { mod: 10 },
    skills: { acrobatics: { base: 8 }, athletics: { base: 8 }, stealth: { base: 10 } },
    attributes: { hp: { value: 60, max: 60 } },
  },
  items: [{ _id: 'l1', type: 'lore', name: 'Warfare Lore', system: { mod: { value: 9 } } }],
  effects: [],
});

const character = () => ({
  _id: ID(1),
  name: 'Hero',
  type: 'character',
  system: {
    details: { level: { value: 1 }, keyability: { value: 'dex' } },
    build: { attributes: { boosts: { 1: ['wis', 'con', 'dex', 'str'] } } },
    skills: { stealth: { rank: 1 } },
    attributes: { hp: { value: 20, max: 20 } },
  },
  items: [
    {
      _id: 'a1',
      type: 'ancestry',
      name: 'Dwarf',
      system: {
        boosts: {
          0: { value: ['con'] },
          1: { value: ['wis'] },
          2: { selected: 'str', value: ['str', 'dex', 'con', 'int', 'wis', 'cha'] },
        },
        flaws: { 0: { value: ['cha'] } },
      },
    },
    {
      _id: 'b1',
      type: 'background',
      name: 'Disciple',
      system: {
        boosts: {
          0: { selected: 'dex', value: ['dex', 'str'] },
          1: { selected: 'str', value: ['str', 'dex'] },
        },
        trainedSkills: { value: ['athletics'] },
      },
    },
    {
      _id: 'c1',
      type: 'class',
      name: 'Gunner',
      system: {
        keyAbility: { value: ['dex'] },
        savingThrows: { fortitude: 2, reflex: 2, will: 1 },
        perception: 2,
        trainedSkills: { value: [] },
      },
    },
    {
      _id: 'l2',
      type: 'lore',
      name: 'Warfare Lore',
      system: { proficient: { value: 1 } },
    },
  ],
  effects: [],
});

const check = (actor: object, kind: string, opts = {}) =>
  pf2eAdapter.buildCheck(actor as Record<string, unknown>, kind, opts);

describe('pf2e adapter', () => {
  it('degree of success with the natural 20 / 1 step', () => {
    expect(degreeOfSuccess(25, 10, 15)).toBe('critical success');
    expect(degreeOfSuccess(15, 10, 15)).toBe('success');
    expect(degreeOfSuccess(14, 10, 15)).toBe('failure');
    expect(degreeOfSuccess(5, 3, 15)).toBe('critical failure');
    expect(degreeOfSuccess(14, 20, 15)).toBe('success');
    expect(degreeOfSuccess(24, 20, 15)).toBe('critical success');
    expect(degreeOfSuccess(16, 1, 15)).toBe('failure');
    expect(degreeOfSuccess(6, 1, 15)).toBe('critical failure');
  });
  it('uses NPC source values for saves, perception, skills and lore', () => {
    expect(check(npc(), 'save', { key: 'ref' }).formula).toBe('1d20 + 12');
    expect(check(npc(), 'save', { key: 'will', target: 18 }).label).toContain('vs DC 18');
    expect(check(npc(), 'perception').formula).toBe('1d20 + 10');
    expect(check(npc(), 'skill', { key: 'ste' }).formula).toBe('1d20 + 10');
    expect(check(npc(), 'skill', { key: 'warfare' }).formula).toBe('1d20 + 9');
    // Untrained NPC skills fall back to the attribute modifier.
    const d = check(npc(), 'skill', { key: 'diplomacy' });
    expect(d.formula).toBe('1d20 - 1');
    expect(d.label).toContain('untrained');
    expect(check(npc(), 'save', { key: 'fort', modifier: -2 }).formula).toBe('1d20 + 8');
  });
  it('rebuilds character attributes from boosts', () => {
    expect(characterAttributes(character())).toEqual({
      str: 3,
      dex: 3,
      con: 2,
      int: 0,
      wis: 2,
      cha: -1,
    });
    // A boost at +4 or more only adds half.
    const strong = character();
    strong.system.build.attributes.boosts = { 1: ['str', 'str'] } as never;
    expect(characterAttributes(strong).str).toBe(4);
  });
  it('builds character checks from rank, level and attribute', () => {
    // reflex: expert (2) → 4 + 1 + dex 3 = 8
    expect(check(character(), 'save', { key: 'reflex' }).formula).toBe('1d20 + 8');
    expect(check(character(), 'perception').formula).toBe('1d20 + 7');
    // trained via background: 2 + 1 + str 3
    expect(check(character(), 'skill', { key: 'athletics' }).formula).toBe('1d20 + 6');
    // trained in system.skills
    expect(check(character(), 'skill', { key: 'stealth' }).formula).toBe('1d20 + 6');
    expect(check(character(), 'skill', { key: 'arcana' }).formula).toBe('1d20');
    expect(check(character(), 'skill', { key: 'warfare lore' }).formula).toBe('1d20 + 3');
    expect(() => check(character(), 'skill', { key: 'basket weaving' })).toThrow();
    expect(() => check(character(), 'save', { key: 'luck' })).toThrow();
  });
  it('evaluates against the DC', () => {
    const c = check(npc(), 'save', { key: 'reflex', target: 20 });
    expect(c.evaluate(30, 18)).toBe('critical success');
    expect(c.evaluate(19, 7)).toBe('failure');
    expect(check(npc(), 'perception').evaluate(15, 5)).toBe('no DC given');
  });
});

const pf2eWorld = () => {
  const w = makeWorld();
  (w as { system: { id: string } }).system = { id: 'pf2e' };
  w.actors = [character(), npc()] as never;
  return w;
};

const frightened = {
  _id: 'TBSHQspnbcqxsmjL',
  type: 'condition',
  name: 'Frightened',
  img: 'systems/pf2e/icons/conditions/frightened.webp',
  folder: null,
  system: { slug: 'frightened', value: { isValued: true, immutable: false, value: 1 } },
};
const prone = {
  _id: 'p1',
  type: 'condition',
  name: 'Prone',
  system: { slug: 'prone', value: { isValued: false, value: null } },
};

describe('pf2e system_roll and set_condition', () => {
  it('system_roll posts a degree of success', async () => {
    const { client, gmModify } = makeClient(pf2eWorld());
    const { text } = await run('system_roll', client, {
      actorId: 'Archer',
      kind: 'save',
      key: 'reflex',
      target: 18,
    });
    expect(text).toMatch(/critical success|success|failure|critical failure/);
    expect(gmModify.mock.calls[0]?.[0]).toBe('ChatMessage');
  });
  it('adds a valued condition from the compendium', async () => {
    const { client, gmModify } = makeClient(pf2eWorld());
    const gmGet = client.gmGet as unknown as { mockResolvedValue: (v: unknown) => void };
    gmGet.mockResolvedValue([frightened, prone]);
    const { text } = await run('set_condition', client, {
      actorId: 'Archer',
      statusId: 'frightened',
      active: true,
      value: 2,
    });
    expect(text).toContain('frightened 2');
    const [type, action, op] = gmModify.mock.calls[0] as [string, string, Record<string, unknown>];
    expect([type, action, op.parentUuid]).toEqual(['Item', 'create', `Actor.${ID(2)}`]);
    const data = (op.data as Record<string, unknown>[])[0] as {
      system: { value: { value: number } };
      _id?: string;
      _stats: unknown;
    };
    expect(data.system.value.value).toBe(2);
    expect(data._id).toBeUndefined();
    expect(data._stats).toEqual({
      compendiumSource: 'Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL',
    });
  });
  it('updates, then removes, an existing valued condition', async () => {
    const w = pf2eWorld();
    (w.actors[1] as { items: object[] }).items.push({ ...frightened, _id: 'f1' });
    const { client, gmModify } = makeClient(w);
    await run('set_condition', client, {
      actorId: 'Archer',
      statusId: 'frightened',
      active: true,
      value: 3,
    });
    expect(gmModify.mock.calls[0]?.slice(0, 2)).toEqual(['Item', 'update']);
    expect((gmModify.mock.calls[0]![2] as { updates: unknown }).updates).toEqual([
      { _id: 'f1', 'system.value.value': 3 },
    ]);
    const off = await run('set_condition', client, {
      actorId: 'Archer',
      statusId: 'frightened',
      active: true,
      value: 0,
    });
    expect(off.text).toContain('frightened off');
    expect(gmModify.mock.calls[1]?.slice(0, 2)).toEqual(['Item', 'delete']);
  });
  it('rejects values on unvalued conditions and in systems without them', async () => {
    const { client } = makeClient(pf2eWorld());
    const r = await run('set_condition', client, {
      actorId: 'Archer',
      statusId: 'prone',
      active: true,
      value: 2,
    });
    expect(r.res.isError).toBe(true);
    const plain = makeClient();
    const p = await run('set_condition', plain.client, {
      actorId: ID(1),
      statusId: 'prone',
      active: true,
      value: 2,
    });
    expect(p.text).toContain('no valued conditions');
  });
});

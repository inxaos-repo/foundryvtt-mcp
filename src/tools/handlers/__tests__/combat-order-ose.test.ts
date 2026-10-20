import { describe, expect, it } from 'vitest';
import type { WorldCombat, WorldData } from '../../../foundry/types.js';
import { computeNextTurn } from '../combat-mutations.js';
import { getCurrentCombatant, getTurnOrder, turnOrderContext } from '../combat-order.js';

const PLAYER = 'playerUser000001';
const GM = 'gmUser0000000001';

function makeWorld(
  systemId: string,
  combat: WorldCombat,
  tokens: Record<string, unknown>[],
): WorldData {
  return {
    userId: GM,
    system: { id: systemId },
    users: [
      { _id: GM, name: 'Gamemaster', role: 4 },
      { _id: PLAYER, name: 'Player', role: 1 },
    ],
    actors: [
      {
        _id: 'actorPC',
        name: 'Hero',
        type: 'character',
        system: {},
        ownership: { default: 0, [PLAYER]: 3 },
      },
      { _id: 'actorMon', name: 'Aardvark', type: 'monster', system: {}, ownership: { default: 0 } },
      {
        _id: 'actorNeutral',
        name: 'Bystander',
        type: 'monster',
        system: {},
        ownership: { default: 0 },
      },
    ],
    scenes: [{ _id: 'scene1', name: 'S', active: true, tokens }],
    combats: [combat],
  } as unknown as WorldData;
}

const tie = (): WorldCombat =>
  ({
    _id: 'combat1',
    scene: 'scene1',
    active: true,
    round: 1,
    turn: 0,
    combatants: [
      // ids/names chosen so core's id order and name order both put the monster first
      {
        _id: 'aaaaMonster00001',
        actorId: 'actorMon',
        tokenId: 'tokMon',
        sceneId: 'scene1',
        name: '',
        initiative: 4,
        hidden: false,
        defeated: false,
      },
      {
        _id: 'zzzzHero00000001',
        actorId: 'actorPC',
        tokenId: 'tokPC',
        sceneId: 'scene1',
        name: '',
        initiative: 4,
        hidden: false,
        defeated: false,
      },
      {
        _id: 'bbbbNeutral00001',
        actorId: 'actorNeutral',
        tokenId: 'tokN',
        sceneId: 'scene1',
        name: '',
        initiative: 4,
        hidden: false,
        defeated: false,
      },
    ],
  }) as unknown as WorldCombat;

const tokens = [
  { _id: 'tokMon', name: 'Aardvark', actorId: 'actorMon', disposition: -1 },
  { _id: 'tokPC', name: 'Hero', actorId: 'actorPC', disposition: 1 },
  { _id: 'tokN', name: 'Bystander', actorId: 'actorNeutral', disposition: 0 },
];

describe('OSE initiative tie-break (mirrors OSECombat#_sortCombatants)', () => {
  it('orders equal initiative by disposition: friendly > neutral > hostile', () => {
    const c = tie();
    const ctx = turnOrderContext(makeWorld('ose', c, tokens), c);
    expect(getTurnOrder(c, ctx).map((x) => x.actorId)).toEqual([
      'actorPC',
      'actorNeutral',
      'actorMon',
    ]);
    expect(getCurrentCombatant(c, ctx)?.actorId).toBe('actorPC');
  });

  it('player-owned beats non-player-owned at equal disposition', () => {
    const c = tie();
    const t = tokens.map((x) => ({ ...x, disposition: -1 }));
    const ctx = turnOrderContext(makeWorld('ose', c, t), c);
    expect(getTurnOrder(c, ctx)[0]?.actorId).toBe('actorPC');
  });

  it('falls back to name (token name when combatant name empty) then id', () => {
    const c = tie();
    const t = [
      { _id: 'tokMon', name: 'Aardvark', actorId: 'actorMon', disposition: -1 },
      { _id: 'tokPC', name: 'Hero', actorId: 'actorMon', disposition: -1 },
      { _id: 'tokN', name: 'Bystander', actorId: 'actorMon', disposition: -1 },
    ];
    const ctx = turnOrderContext(makeWorld('ose', c, t), c);
    expect(getTurnOrder(c, ctx).map((x) => ctx?.displayName(x))).toEqual([
      'Hero',
      'Aardvark',
      'Bystander',
    ]);
  });

  it('colour groups (group initiative) order by OSE GROUPS keys before disposition', () => {
    const c = tie() as unknown as Record<string, unknown>;
    c.groups = [
      { _id: 'g1', name: 'red' },
      { _id: 'g2', name: 'green' },
    ];
    const cs = c.combatants as Record<string, unknown>[];
    cs[1].group = 'g1'; // hero red
    cs[0].group = 'g2'; // monster green
    const combat = c as unknown as WorldCombat;
    const ctx = turnOrderContext(makeWorld('ose', combat, tokens), combat);
    expect(getTurnOrder(combat, ctx)[0]?.actorId).toBe('actorMon');
  });

  it('higher initiative still wins regardless of tie-break', () => {
    const c = tie();
    c.combatants[0].initiative = 5;
    const ctx = turnOrderContext(makeWorld('ose', c, tokens), c);
    expect(getTurnOrder(c, ctx)[0]?.actorId).toBe('actorMon');
  });

  it('non-OSE systems keep core id tie-break', () => {
    const c = tie();
    const ctx = turnOrderContext(makeWorld('dnd5e', c, tokens), c);
    expect(getTurnOrder(c, ctx)[0]?._id).toBe('aaaaMonster00001');
  });

  it('computeNextTurn walks the OSE order and begins an unstarted combat at round 1', () => {
    const c = tie();
    const ctx = turnOrderContext(makeWorld('ose', c, tokens), c);
    expect(computeNextTurn(c, false, ctx)).toEqual({ turn: 1, round: 1 });
    const unstarted = { ...c, round: 0, turn: null } as WorldCombat;
    expect(computeNextTurn(unstarted, false, ctx)).toEqual({ turn: 0, round: 1 });
  });
});

import { describe, expect, it } from 'vitest';
import { hasLineOfSight, squaresBetween } from '../lookup.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

const combatWorld = () => {
  const w = makeWorld();
  w.combats = [
    {
      _id: ID(90),
      active: true,
      round: 2,
      turn: 0,
      scene: ID(10),
      combatants: [
        {
          _id: ID(91),
          tokenId: ID(61),
          actorId: ID(1),
          sceneId: ID(10),
          name: 'Fighter',
          initiative: 15,
        },
        {
          _id: ID(92),
          tokenId: ID(60),
          actorId: ID(2),
          sceneId: ID(10),
          name: 'Goblin',
          initiative: 3,
        },
      ],
    },
  ];
  return w;
};

describe('lookup geometry', () => {
  it('measures edge to edge in squares', () => {
    const a = { x: 0, y: 0, width: 1, height: 1 };
    expect(squaresBetween(a, { x: 100, y: 0 }, 100)).toBe(1);
    expect(squaresBetween(a, { x: 300, y: 200 }, 100)).toBe(3);
    // A 2x2 token right next to a 1x1 one is 1 square away.
    expect(squaresBetween(a, { x: 100, y: 0, width: 2, height: 2 }, 100)).toBe(1);
  });
  it('line of sight respects open doors, sight-less walls and limited walls', () => {
    const from = { x: 50, y: 50 };
    const to = { x: 450, y: 50 };
    const wall = (x: number, extra = {}) => ({ _id: `w${x}`, c: [x, 0, x, 100], ...extra });
    expect(hasLineOfSight([wall(100)], from, to)).toBe(false);
    expect(hasLineOfSight([wall(100, { door: 1, ds: 1 })], from, to)).toBe(true);
    expect(hasLineOfSight([wall(100, { sight: 0 })], from, to)).toBe(true);
    expect(hasLineOfSight([wall(100, { sight: 10 })], from, to)).toBe(true);
    expect(hasLineOfSight([wall(100, { sight: 10 }), wall(200, { sight: 10 })], from, to)).toBe(
      false,
    );
  });
});

describe('tokens_near', () => {
  it('lists nearby tokens with distance, HP and LoS', async () => {
    const { client } = makeClient();
    const { text, res } = await run('tokens_near', client, { tokenId: ID(61), radius: 5 });
    expect(text).toContain('Goblin');
    expect(text).toContain('3 sq');
    expect(text).toContain('no LoS');
    expect(text).toContain('HP 4/4');
    expect(res.isError).toBeFalsy();
  });
  it('filters by radius, disposition and hidden', async () => {
    const { client } = makeClient();
    expect((await run('tokens_near', client, { tokenId: ID(61), radius: 2 })).text).toContain(
      '(none)',
    );
    expect(
      (await run('tokens_near', client, { tokenId: ID(61), includeHidden: false })).text,
    ).toContain('(none)');
    expect(
      (await run('tokens_near', client, { tokenId: ID(61), disposition: 'hostile' })).text,
    ).toContain('(none)');
    const pt = await run('tokens_near', client, { x: 450, y: 150, radius: 0 });
    expect(pt.text).toContain('Goblin');
    expect(pt.text).not.toContain('LoS');
  });
});

describe('token_for_actor', () => {
  it('finds tokens by actor name across scenes', async () => {
    const { client } = makeClient();
    const { text } = await run('token_for_actor', client, { actorId: 'Goblin' });
    expect(text).toContain(ID(60));
    expect(text).toContain('Dungeon (active)');
    expect(text).toContain('unlinked');
  });
  it('reports when an actor has no token', async () => {
    const w = makeWorld();
    w.scenes[0]!.tokens = [];
    const { client } = makeClient(w);
    const { text } = await run('token_for_actor', client, { actorId: ID(1) });
    expect(text).toContain('No token');
  });
});

describe('turn_context', () => {
  it('summarises the current combatant and its surroundings', async () => {
    const { client } = makeClient(combatWorld());
    const { text } = await run('turn_context', client, { map: true, mapRadius: 3 });
    expect(text).toContain('Round 2, turn 1: Fighter');
    expect(text).toContain('HP 8/10');
    expect(text).toContain('Goblin');
    expect(text).toContain('@');
    expect(text).toContain('+'); // the closed door at x=300
    expect(text).toContain('A=Goblin');
  });
  it('handles no active combat', async () => {
    const { client } = makeClient();
    const { res } = await run('turn_context', client, {});
    expect(res.isError).toBe(true);
  });
});

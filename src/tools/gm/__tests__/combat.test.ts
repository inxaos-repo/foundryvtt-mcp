import { describe, expect, it } from 'vitest';
import { advance, sortTurns } from '../combat.js';
import { ID, makeClient, run } from './fixtures.js';

describe('combat', () => {
  it('turn sorting and advancing', () => {
    const order = sortTurns([
      { _id: 'a', name: 'A', initiative: 2 },
      { _id: 'b', name: 'B', initiative: 5 },
      { _id: 'c', name: 'C' },
    ]);
    expect(order.map((o) => o._id)).toEqual(['b', 'a', 'c']);
    expect(advance(1, 1, 2, 'next_turn')).toEqual({ round: 2, turn: 0 });
    expect(advance(2, 0, 2, 'previous_turn')).toEqual({ round: 1, turn: 1 });
    expect(advance(0, 0, 2, 'next_turn')).toEqual({ round: 1, turn: 0 });
  });
  it('start_encounter creates combat and combatants', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(60), ID(61)] });
    expect(gmModify.mock.calls.map((c) => `${c[0]}:${c[1]}`)).toEqual([
      'Combat:create',
      'Combatant:create',
      'Combat:update',
    ]);
  });
  it('start_encounter uses the system adapter initiative formula', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(61)] });
    const data = (gmModify.mock.calls[1]?.[2] as { data: Array<{ initiative: number }> }).data;
    expect(data[0]?.initiative).toBeGreaterThanOrEqual(1);
    expect(data[0]?.initiative).toBeLessThanOrEqual(6);
  });
});

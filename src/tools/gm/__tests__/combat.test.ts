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
      'CombatantGroup:create',
      'CombatantGroup:update',
      'Combatant:create',
      'Combat:update',
    ]);
  });
  it('start_encounter uses the system adapter initiative formula', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(61)] });
    const create = gmModify.mock.calls.find((c) => c[0] === 'Combatant' && c[1] === 'create');
    const data = ((create as unknown[])[2] as { data: Array<{ initiative: number }> }).data;
    expect(data[0]?.initiative).toBeGreaterThanOrEqual(1);
    expect(data[0]?.initiative).toBeLessThanOrEqual(6);
  });
});

describe('combat: OSE group initiative + reveal', () => {
  it('start_encounter rolls one d6 per side in OSE group mode (default)', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(60), ID(61)] });
    const calls = gmModify.mock.calls.map((c) => `${c[0]}:${c[1]}`);
    expect(calls).toContain('CombatantGroup:create');
    const create = gmModify.mock.calls.find((c) => c[0] === 'Combatant' && c[1] === 'create');
    const data = (
      (create as unknown[])[2] as { data: Array<{ group?: string; initiative?: number }> }
    ).data;
    expect(data.every((d) => typeof d.group === 'string')).toBe(true);
  });
  it('members of one side share the roll', async () => {
    const { client, gmModify, w } = makeClient();
    const tokens = (w.scenes[0] as { tokens: Array<Record<string, unknown>> }).tokens;
    tokens.push({ ...tokens[0], _id: 'goblin2000000000', disposition: -1 });
    (tokens[0] as Record<string, unknown>).disposition = -1;
    await run('start_encounter', client, { tokenIds: [ID(60), 'goblin2000000000'] });
    const create = gmModify.mock.calls.find((c) => c[0] === 'Combatant' && c[1] === 'create');
    const data = (
      (create as unknown[])[2] as { data: Array<{ group?: string; initiative?: number }> }
    ).data;
    expect(data[0]?.initiative).toBe(data[1]?.initiative);
    expect(data[0]?.group).toBe(data[1]?.group);
  });
  it('individual setting keeps per-combatant rolls', async () => {
    const { client, gmModify, w } = makeClient();
    (w as unknown as { settings: unknown[] }).settings = [
      { key: 'ose.initiative', value: '"individual"' },
    ];
    await run('start_encounter', client, { tokenIds: [ID(60), ID(61)] });
    expect(gmModify.mock.calls.map((c) => c[0])).not.toContain('CombatantGroup');
  });
  it('revealHidden unhides tokens and combatants', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(60)], revealHidden: true });
    const tok = gmModify.mock.calls.find((c) => c[0] === 'Token' && c[1] === 'update');
    expect(
      ((tok as unknown[])[2] as { updates: Array<{ hidden: boolean }> }).updates[0]?.hidden,
    ).toBe(false);
    const create = gmModify.mock.calls.find((c) => c[0] === 'Combatant' && c[1] === 'create');
    expect(((create as unknown[])[2] as { data: Array<{ hidden: boolean }> }).data[0]?.hidden).toBe(
      false,
    );
  });
});

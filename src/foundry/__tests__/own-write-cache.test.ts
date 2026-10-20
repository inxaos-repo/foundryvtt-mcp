import { describe, expect, it, vi } from 'vitest';
import { FoundryClient } from '../client.js';

/**
 * Foundry only broadcasts a mutation to *other* sockets, so the bridge must
 * apply its own writes to the cached worldData. Regression: ending a combat
 * through the bridge left the deleted encounter cached, and combat_state kept
 * reporting the stale turn order until a restart.
 */
function clientWithCombat() {
  const client = new FoundryClient({
    baseUrl: 'http://localhost:30000',
    writeEnabled: true,
  } as never);
  const c = client as unknown as Record<string, unknown>;
  c.socket = { connected: true };
  c.worldData = {
    combats: [
      {
        _id: 'CmbAAAAAAAAAAAAA',
        active: true,
        round: 2,
        turn: 0,
        combatants: [{ _id: 'CbtAAAAAAAAAAAAA', name: 'Hound', initiative: 4 }],
      },
    ],
    actors: [],
    scenes: [],
    items: [],
    journal: [],
    messages: [],
    users: [],
    settings: [],
  };
  const emit = vi.fn();
  c.emitWithAck = emit;
  return { client, emit };
}

describe('own writes update the world cache', () => {
  it('end_combat (Combat delete) clears the cached active combat', async () => {
    const { client, emit } = clientWithCombat();
    emit.mockResolvedValue({ result: ['CmbAAAAAAAAAAAAA'] });
    expect(client.getCombatState()?._id).toBe('CmbAAAAAAAAAAAAA');
    await client.endCombat('CmbAAAAAAAAAAAAA');
    expect(client.getCombatState()).toBeNull();
  });

  it('a Combat update (next turn) is reflected in the cache', async () => {
    const { client, emit } = clientWithCombat();
    emit.mockResolvedValue({ result: [{ _id: 'CmbAAAAAAAAAAAAA', round: 3, turn: 0 }] });
    await (
      client as unknown as { modifyDocument: (...a: unknown[]) => Promise<unknown> }
    ).modifyDocument('Combat', 'update', { updates: [{ _id: 'CmbAAAAAAAAAAAAA', round: 3 }] });
    expect(client.getCombatState()?.round).toBe(3);
  });

  it('a rejected write leaves the cache untouched', async () => {
    const { client, emit } = clientWithCombat();
    emit.mockResolvedValue({ error: { message: 'nope' } });
    await expect(client.endCombat('CmbAAAAAAAAAAAAA')).rejects.toThrow('nope');
    expect(client.getCombatState()?._id).toBe('CmbAAAAAAAAAAAAA');
  });
});

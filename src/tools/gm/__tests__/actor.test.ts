import { describe, expect, it } from 'vitest';
import { ID, makeClient, run } from './fixtures.js';

describe('actor state', () => {
  it('apply_damage clamps and uses token delta for unlinked tokens', async () => {
    const { client, gmModify } = makeClient();
    const r = await run('apply_damage', client, { actorId: 'Test Fighter', amount: 20 });
    expect(r.text).toContain('8 → 0');
    await run('apply_damage', client, { tokenId: ID(60), amount: 1 });
    expect(gmModify).toHaveBeenLastCalledWith(
      'Token',
      'update',
      expect.objectContaining({ updates: [{ _id: ID(60), 'delta.system.hp.value': 3 }] }),
    );
  });
  it('adjust_item_quantity handles nested quantity.value', async () => {
    const { client, gmModify } = makeClient();
    await run('adjust_item_quantity', client, { actorId: ID(1), item: 'Gold', delta: -3 });
    expect(gmModify).toHaveBeenCalledWith(
      'Item',
      'update',
      expect.objectContaining({ updates: [{ _id: ID(9), 'system.quantity.value': 7 }] }),
    );
  });
  it('set_condition writes an unlinked token status to its ActorDelta', async () => {
    const { client, gmModify } = makeClient();
    const r = await run('set_condition', client, {
      tokenId: ID(60),
      statusId: 'prone',
      active: true,
    });
    expect(r.res.isError).toBeFalsy();
    expect(gmModify).toHaveBeenCalledWith(
      'ActiveEffect',
      'create',
      expect.objectContaining({
        parentUuid: `Scene.${ID(10)}.Token.${ID(60)}.ActorDelta.${ID(60)}`,
        data: [
          expect.objectContaining({
            statuses: ['prone'],
            img: 'icons/svg/falling.svg',
            showIcon: 2,
          }),
        ],
      }),
    );
  });
});

describe('apply_damage defeated sync', () => {
  it('marks the combatant defeated at 0 HP and adds dead status', async () => {
    const { makeClient: mk, run: r, ID: id } = await import('./fixtures.js');
    const { client, gmModify, w } = mk();
    w.combats.push({
      _id: 'combat0000000001',
      combatants: [{ _id: 'cbt0000000000001', tokenId: id(60), actorId: id(2) }],
    });
    await r('apply_damage', client, { tokenId: id(60), amount: 99 });
    const upd = gmModify.mock.calls.find((c) => c[0] === 'Combatant' && c[1] === 'update');
    expect(
      ((upd as unknown[])[2] as { updates: Array<{ defeated: boolean }> }).updates[0]?.defeated,
    ).toBe(true);
    expect(gmModify.mock.calls.some((c) => c[0] === 'ActiveEffect' && c[1] === 'create')).toBe(
      true,
    );
  });
});

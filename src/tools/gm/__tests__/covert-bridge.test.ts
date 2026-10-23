import { describe, expect, it, vi } from 'vitest';
import { bridgeRequest, gmBrowserActive } from '../covert-bridge.js';
import { covertOps, covertOpsSummary } from '../systems/covert-ops.js';
import { makeClient, makeWorld, run } from './fixtures.js';

type O = Record<string, unknown>;

function codWorld(extra: O = {}) {
  const w = makeWorld();
  (w as { system: { id: string } }).system = { id: 'covert-ops-d20' };
  const a = w.actors[0] as O;
  a.name = 'Agent Smith';
  a.type = 'character';
  a.system = {
    level: 1,
    bab: 1,
    abilities: { str: { value: 10 }, dex: { value: 14, bonus: 2 }, con: { value: 12 } },
    skills: { sneak: { ranks: 4, ability: 'dex', bonus: 1 } },
    saves: { fort: { base: 2 }, ref: { base: 0 }, will: { base: 0 } },
    defense: { classBonus: 1 },
    vitality: { value: 20, max: 20 },
    wounds: { value: 12, max: 12 },
  };
  a.items = [
    { type: 'origin', system: { abilityAdjustments: { dex: 2 } } },
    {
      type: 'armor',
      system: { equipped: true, dr: { melee: 3, ranged: 2 }, defenseMod: -1, checkPenalty: -2 },
    },
    { type: 'armor', system: { equipped: false, dr: { melee: 9, ranged: 9 } } },
  ];
  Object.assign(a, extra);
  return w;
}

describe('covert-ops-d20 v0.3 bridge', () => {
  it('recomputes origin adjustments, bonus fields and worn armor', () => {
    // biome-ignore lint/suspicious/noExplicitAny: nested summary
    const s = covertOpsSummary(codWorld().actors[0] as O) as any;
    expect(s.source).toBe('recomputed');
    expect(s.abilities.dex.score).toBe(18); // 14 + origin 2 + bonus 2
    expect(s.skills.sneak.total).toBe(4 + 4 + 1 - 2); // ranks + dex + bonus + ACP
    expect(s.defense).toBe(10 + 1 + 4 - 1);
    expect(s.armor.dr).toEqual({ melee: 3, ranged: 2 });
  });

  it('prefers the system-derived snapshot', () => {
    const w = codWorld({
      flags: {
        'covert-ops-d20': {
          derived: { v: 1, defense: 22, skills: { sneak: { total: 13, threat: 19, error: 1 } } },
        },
      },
    });
    // biome-ignore lint/suspicious/noExplicitAny: nested summary
    const s = covertOpsSummary(w.actors[0] as O) as any;
    expect(s.source).toBe('derived');
    expect(covertOps.buildCheck(w.actors[0] as O, 'skill', { key: 'sneak' }).formula).toBe(
      '1d20 + 13',
    );
  });

  it('fallback damage honours armor DR by attack kind', async () => {
    const { client, gmModify } = makeClient(codWorld());
    await run('apply_damage', client, { actorId: 'Agent Smith', amount: 8, attack: 'melee' });
    expect(gmModify.mock.calls[0]?.[2].updates[0]['system.vitality.value']).toBe(15);
    await run('apply_damage', client, {
      actorId: 'Agent Smith',
      amount: 8,
      attack: 'ranged',
      ap: 1,
    });
    expect(gmModify.mock.calls[1]?.[2].updates[0]['system.vitality.value']).toBe(13); // 20 - (8 - (2 - 1))
  });

  it('detects a GM browser and relays damage through the system', async () => {
    const w = codWorld();
    expect(gmBrowserActive(makeClient(w).client)).toBe(false);
    (w as { activeUsers: string[] }).activeUsers.push('gm00000000000001');
    const { client, gmModify } = makeClient(w);
    expect(gmBrowserActive(client)).toBe(true);
    gmModify.mockImplementation(async (_t: string, _a: string, op: O) => {
      const u = (op.updates as O[])[0] as O;
      const req = u['flags.covert-ops-d20.bridgeRequest'] as O;
      setTimeout(() => {
        (w.actors[0] as O).flags = {
          'covert-ops-d20': {
            bridgeResult: {
              id: req.id,
              ok: true,
              lines: ['Took 5 lethal.'],
              damage: 5,
              derived: { vitality: { value: 15 } },
            },
          },
        };
      }, 5);
      return [u];
    });
    const r = await run('apply_damage', client, {
      actorId: 'Agent Smith',
      amount: 8,
      attack: 'melee',
    });
    expect(r.text).toContain('Took 5 lethal.');
    const req = gmModify.mock.calls[0]?.[2].updates[0]['flags.covert-ops-d20.bridgeRequest'];
    expect(req).toMatchObject({ op: 'damage', amount: 8, attack: 'melee' });
  });

  it('bridgeRequest times out to undefined', async () => {
    const w = codWorld();
    (w as { activeUsers: string[] }).activeUsers.push('gm00000000000001');
    const { client } = makeClient(w);
    vi.useRealTimers();
    // biome-ignore lint/suspicious/noExplicitAny: target shape
    expect(
      await bridgeRequest(
        client,
        { actor: w.actors[0], unlinked: false } as any,
        { op: 'derive' },
        50,
        10,
      ),
    ).toBeUndefined();
  });

  it('standard NPCs still refused without a GM browser', async () => {
    const w = codWorld({ type: 'npc' });
    ((w.actors[0] as O).system as O).vitality = { value: 0, max: 0 };
    const r = await run('apply_damage', makeClient(w).client, {
      actorId: 'Agent Smith',
      amount: 5,
    });
    expect(r.text).toMatch(/Damage save/);
  });
});

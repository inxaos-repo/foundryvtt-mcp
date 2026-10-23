import { describe, expect, it } from 'vitest';
import { codVerdict, covertOps, covertOpsSummary } from '../systems/covert-ops.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

const agentSystem = () => ({
  level: 3,
  bab: 2,
  abilities: {
    str: { value: 12 },
    dex: { value: 16 },
    con: { value: 14 },
    int: { value: 10 },
    wis: { value: 13 },
    cha: { value: 8 },
  },
  skills: {
    notice: { ranks: 6, ability: 'wis', misc: 1, threat: 19, error: 1 },
    sneak: { ranks: 4, ability: 'dex', misc: 0, threat: 20, error: 2, focus: 'urban' },
  },
  saves: { fort: { base: 3, misc: 0 }, ref: { base: 1, misc: 1 }, will: { base: 1, misc: 0 } },
  defense: { classBonus: 2, misc: 0 },
  initiative: { classBonus: 1, misc: 0 },
  attackRange: { threat: 20, error: 1 },
  vitality: { value: 20, max: 24 },
  wounds: { value: 14, max: 14 },
  actionDice: { value: 3, die: 4 },
});

function codWorld() {
  const w = makeWorld();
  (w as { system: { id: string } }).system = { id: 'covert-ops-d20' };
  const a = w.actors[0] as Record<string, unknown>;
  a.name = 'Agent Smith';
  a.system = agentSystem();
  return w;
}

describe('covert-ops-d20', () => {
  it('derives totals from stored data', () => {
    // biome-ignore lint/suspicious/noExplicitAny: test reads nested summary fields
    const s = covertOpsSummary(codWorld().actors[0] as Record<string, unknown>) as any;
    expect(s.skills.notice.total).toBe(8); // 6 + wis 1 + 1
    expect(s.skills.sneak.total).toBe(7); // 4 + dex 3
    expect(s.saves).toEqual({ fort: 5, ref: 5, will: 2 });
    expect(s.defense).toBe(15);
    expect(s.initiative).toBe(4);
    expect(s.attack).toEqual({ melee: 3, ranged: 5 });
    expect(s.checks.knowledge).toBe(3);
    expect(s.actionDice).toEqual({ value: 3, die: 4 });
  });

  it('builds checks with threat/error verdicts', () => {
    const actor = codWorld().actors[0] as Record<string, unknown>;
    const c = covertOps.buildCheck(actor, 'skill', { key: 'notice', target: 15 });
    expect(c.formula).toBe('1d20 + 8');
    expect(c.evaluate(27, 19)).toBe('SUCCESS, THREAT (natural 19)');
    expect(c.evaluate(9, 1)).toBe('FAILURE, ERROR (natural 1)');
    const sneak = covertOps.buildCheck(actor, 'skill', { key: 'sneak' });
    expect(sneak.evaluate(9, 2)).toContain('ERROR');
    expect(covertOps.buildCheck(actor, 'attack', { variant: 'ranged', target: 14 }).formula).toBe(
      '1d20 + 5',
    );
    expect(covertOps.buildCheck(actor, 'save', { key: 'will', modifier: -2 }).formula).toBe('1d20');
    expect(() => covertOps.buildCheck(actor, 'skill', { key: 'nope' })).toThrow(/notice/);
    expect(codVerdict(10, 10, 20, 1)).toBe('total 10');
  });

  it('system_roll spends action dice', async () => {
    const { client, gmModify } = makeClient(codWorld());
    const r = await run('system_roll', client, {
      actorId: 'Agent Smith',
      kind: 'skill',
      key: 'notice',
      target: 10,
      actionDice: 2,
    });
    expect(r.text).toContain('+2 action dice');
    expect(r.text).toContain('action dice left: 1');
    expect(gmModify.mock.calls[1]?.[0]).toBe('Actor');
    expect(gmModify.mock.calls[1]?.[2].updates[0]['system.actionDice.value']).toBe(1);
    const bad = await run('system_roll', client, {
      actorId: 'Agent Smith',
      kind: 'save',
      key: 'fort',
      actionDice: 5,
    });
    expect(bad.res.isError).toBe(true);
  });

  it('covert_ops summary and spend_action_die', async () => {
    const { client, gmModify } = makeClient(codWorld());
    const s = await run('covert_ops', client, { action: 'summary', actorId: ID(1) });
    expect(s.text).toContain('Def 15');
    const sp = await run('covert_ops', client, { action: 'spend_action_die', actorId: ID(1) });
    expect(sp.text).toContain('1d4');
    expect(gmModify.mock.calls[0]?.[2].updates[0]['system.actionDice.value']).toBe(2);
  });

  it('apply_damage uses vitality, excess not carried to wounds', async () => {
    const { client, gmModify } = makeClient(codWorld());
    const r = await run('apply_damage', client, { actorId: 'Agent Smith', amount: 25 });
    expect(r.text).toContain('VP 20 → 0/24');
    expect(r.text).toContain('WP 14 → 14/14');
    expect(gmModify.mock.calls[0]?.[2].updates[0]).toMatchObject({
      'system.vitality.value': 0,
      'system.wounds.value': 14,
    });
    const crit = await run('apply_damage', client, {
      actorId: 'Agent Smith',
      amount: 5,
      toWounds: true,
    });
    expect(crit.text).toContain('VP 20 → 20/24');
    expect(crit.text).toContain('WP 14 → 9/14');
  });

  it('covert_ops refuses other systems', async () => {
    const { client } = makeClient();
    const r = await run('covert_ops', client, { action: 'summary', actorId: ID(1) });
    expect(r.res.isError).toBe(true);
  });
});

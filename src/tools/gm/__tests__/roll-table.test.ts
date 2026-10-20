import { describe, expect, it } from 'vitest';
import { drawFrom, resultLabel, tableFormula } from '../roll-table.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

const table = (extra: Record<string, unknown> = {}) => ({
  _id: ID(70),
  name: 'Wandering Monsters',
  formula: '1d6',
  replacement: true,
  results: [
    { _id: ID(71), type: 'text', name: 'Goblins', range: [1, 3], drawn: false },
    {
      _id: ID(72),
      type: 'document',
      name: 'Ogre',
      documentUuid: `Actor.${ID(2)}`,
      range: [4, 5],
      drawn: false,
    },
    { _id: ID(73), type: 'text', text: 'Nothing', range: [6, 6], drawn: false },
  ],
  ...extra,
});

const tableWorld = (extra: Record<string, unknown> = {}) => {
  const w = makeWorld();
  w.tables = [table(extra), { _id: ID(75), name: 'Treasure', formula: '', results: [] }];
  return w;
};

describe('roll table helpers', () => {
  it('picks the result whose range covers the roll', () => {
    // rng 0 → 1 on a d6, rng 0.99 → 6
    expect(drawFrom(table(), () => 0).results[0]?._id).toBe(ID(71));
    expect(drawFrom(table(), () => 0.99).results[0]?._id).toBe(ID(73));
  });
  it('skips drawn results without replacement and rerolls', () => {
    const t = table({ replacement: false });
    for (const r of t.results.slice(0, 2)) {
      r.drawn = true;
    }
    let i = 0;
    const seq = [0, 0.5, 0.99];
    const d = drawFrom(t, () => seq[i++ % 3] as number);
    expect(d.results[0]?._id).toBe(ID(73));
    t.results[2]!.drawn = true;
    expect(() => drawFrom(t)).toThrow(/reset=true/);
  });
  it('derives a formula and labels', () => {
    expect(tableFormula({ _id: 'x', results: [{ _id: 'a', range: [1, 8] }] })).toBe('1d8');
    expect(resultLabel({ _id: 'a', text: 'Old style' })).toBe('Old style');
    expect(resultLabel({ _id: 'a', name: 'Ogre', description: '<p>Big</p>' })).toBe('Ogre — Big');
  });
});

describe('roll_table', () => {
  it('posts a public draw card with the roll and returns the result', async () => {
    const { client, gmModify } = makeClient(tableWorld());
    const { text, res } = await run('roll_table', client, { table: 'wandering' });
    expect(res.isError).toBeFalsy();
    expect(text).toContain('Wandering Monsters [public]');
    const [type, action, op] = gmModify.mock.calls.at(-1) as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect([type, action]).toEqual(['ChatMessage', 'create']);
    const msg = (op.data as Record<string, unknown>[])[0]!;
    expect(msg.flags).toEqual({ core: { RollTable: ID(70) } });
    expect(msg.rolls).toHaveLength(1);
    expect(msg.whisper).toBeUndefined();
    expect(String(msg.content)).toContain('table-result');
  });
  it('respects gm and blind roll modes', async () => {
    const { client, gmModify } = makeClient(tableWorld());
    await run('roll_table', client, { table: ID(70), mode: 'blind' });
    const msg = (
      (gmModify.mock.calls.at(-1)?.[2] as Record<string, unknown>).data as Record<string, unknown>[]
    )[0]!;
    expect(msg.blind).toBe(true);
    expect(Array.isArray(msg.whisper)).toBe(true);
  });
  it('marks results drawn on tables without replacement, and can reset', async () => {
    const w = tableWorld({ replacement: false });
    (w.tables[0] as { results: { drawn: boolean }[] }).results[0]!.drawn = true;
    const { client, gmModify } = makeClient(w);
    await run('roll_table', client, { table: ID(70), reset: true });
    const calls = gmModify.mock.calls.map((c) => [
      c[0],
      c[1],
      (c[2] as { updates?: unknown }).updates,
    ]);
    expect(calls[0]).toEqual(['TableResult', 'update', [{ _id: ID(71), drawn: false }]]);
    expect(calls[1]?.[0]).toBe('TableResult');
    expect((calls[1]?.[2] as { drawn: boolean }[])[0]?.drawn).toBe(true);
    expect(calls[2]?.slice(0, 2)).toEqual(['ChatMessage', 'create']);
  });
  it('errors on unknown or ambiguous tables', async () => {
    const { client } = makeClient(tableWorld());
    expect((await run('roll_table', client, { table: 'nope' })).res.isError).toBe(true);
    expect((await run('roll_table', client, { table: 'Treasure' })).text).toMatch(/no formula/);
  });
});

import { describe, expect, it } from 'vitest';
import { evaluateDiceFormula } from '../../../foundry/dice-formula.js';
import { toFoundryRoll } from '../chat.js';
import { ID, makeClient, run } from './fixtures.js';

describe('chat and dice', () => {
  it('toFoundryRoll serialises terms', () => {
    const r = evaluateDiceFormula('1d20+2');
    const roll = toFoundryRoll('1d20+2', r) as {
      terms: Array<Record<string, unknown>>;
      total: number;
    };
    expect(roll.terms.map((t) => t.class)).toEqual(['Die', 'OperatorTerm', 'NumericTerm']);
    expect(roll.total).toBe(r.total);
  });
  it('gm_roll blind whispers GMs', async () => {
    const { client, gmModify } = makeClient();
    const { text } = await run('gm_roll', client, { formula: '1d20', mode: 'blind' });
    expect(text).toMatch(/1d20 = \*\*\d+\*\*/);
    const msg = (gmModify.mock.calls[0]?.[2] as { data: Array<Record<string, unknown>> }).data[0];
    expect(msg).toMatchObject({ blind: true, whisper: ['gm00000000000001'] });
  });
  it('post_chat narrates, speaks in character and whispers', async () => {
    const { client, gmModify } = makeClient();
    await run('post_chat', client, { content: 'Dust falls.' });
    await run('post_chat', client, { content: 'Grr', tokenId: ID(60), style: 'ic' });
    await run('post_chat', client, { content: 'psst', whisperTo: ['Alice'] });
    const msgs = gmModify.mock.calls.map(
      (c) => (c[2] as { data: Array<Record<string, unknown>> }).data[0],
    );
    expect(msgs[0]).toMatchObject({ content: '<p><em>Dust falls.</em></p>', style: 0 });
    expect(msgs[1]).toMatchObject({ style: 2, speaker: { token: ID(60), alias: 'Goblin' } });
    expect(msgs[2]).toMatchObject({ whisper: ['player0000000001'] });
  });
  it('read_chat includes player rolls', async () => {
    const { client } = makeClient();
    const { text } = await run('read_chat', client, {});
    expect(text).toContain('"author": "Alice"');
    expect(text).toContain('"total": 14');
  });
});

import { describe, expect, it } from 'vitest';
import { ose } from '../systems/ose.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

describe('system_roll', () => {
  it('ose adapter verdicts', () => {
    const actor = makeWorld().actors[0] as Record<string, unknown>;
    expect(ose.buildCheck(actor, 'save', { key: 'death' }).evaluate(12, 12)).toBe('SUCCESS');
    expect(ose.buildCheck(actor, 'save', { key: 'death' }).evaluate(11, 11)).toBe('FAILURE');
    expect(ose.buildCheck(actor, 'ability', { key: 'str' }).evaluate(13, 13)).toBe('SUCCESS');
    expect(ose.buildCheck(actor, 'attack', { target: 5 }).evaluate(14, 14)).toBe('HIT');
    expect(ose.buildCheck(actor, 'attack', { target: 5 }).evaluate(13, 13)).toBe('MISS');
    expect(() => ose.buildCheck(actor, 'save', { key: 'nope' })).toThrow();
  });
  it('lists kinds for the world system', async () => {
    const { client } = makeClient();
    const { text } = await run('system_roll', client, { kind: 'help' });
    expect(text).toContain('save');
  });

  it('posts a verdict for a save', async () => {
    const { client, gmModify } = makeClient();
    const { text } = await run('system_roll', client, {
      actorId: 'Test Fighter',
      kind: 'save',
      key: 'death',
    });
    expect(text).toMatch(/SUCCESS|FAILURE/);
    expect(gmModify.mock.calls[0]?.[0]).toBe('ChatMessage');
  });

  it('reports a missing adapter', async () => {
    const w = makeWorld();
    (w as { system: { id: string } }).system = { id: 'unknown-system' };
    const { client } = makeClient(w);
    const r = await run('system_roll', client, { actorId: ID(1), kind: 'save' });
    expect(r.res.isError).toBe(true);
    expect(r.text).toContain('No roll adapter');
  });
});

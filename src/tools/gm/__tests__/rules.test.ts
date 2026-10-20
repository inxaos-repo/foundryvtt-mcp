import { describe, expect, it } from 'vitest';
import { getAllTools } from '../../definitions.js';
import { makeClient, run } from './fixtures.js';

describe('lookup_rule', () => {
  it('is registered once', () => {
    expect(getAllTools().filter((t) => t.name === 'lookup_rule')).toHaveLength(1);
  });

  it('searches world journals', async () => {
    const { client } = makeClient();
    const { text } = await run('lookup_rule', client, { query: 'goblins sleep' });
    expect(text).toContain('Room 1 › Key');
  });
});

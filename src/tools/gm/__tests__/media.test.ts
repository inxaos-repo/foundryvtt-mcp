import { describe, expect, it, type vi } from 'vitest';
import { ID, makeClient, run } from './fixtures.js';

describe('sharing, party and rules', () => {
  it('share_journal emits showEntry with page uuid', async () => {
    const { client } = makeClient();
    await run('share_journal', client, { journalId: 'Room 1', pageId: 'Key' });
    expect((client as unknown as { gmEmit: ReturnType<typeof vi.fn> }).gmEmit).toHaveBeenCalledWith(
      'showEntry',
      `JournalEntry.${ID(50)}.JournalEntryPage.${ID(51)}`,
      { force: true },
    );
  });
  it('list_party shows online and characters', async () => {
    const { client } = makeClient();
    const { text } = await run('list_party', client, {});
    expect(text).toContain('1/3 online');
    expect(text).toContain('"name": "Test Fighter"');
  });
  it('lookup_rule searches world journals', async () => {
    const { client } = makeClient();
    const { text } = await run('lookup_rule', client, { query: 'goblins sleep' });
    expect(text).toContain('Room 1 › Key');
  });
});

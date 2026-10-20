import { describe, expect, it, type vi } from 'vitest';
import { ID, makeClient, run } from './fixtures.js';

describe('gm_document', () => {
  it('gm_document requires parent for embedded types', async () => {
    const { client } = makeClient();
    const r = await run('gm_document', client, {
      action: 'create',
      documentType: 'Wall',
      data: {},
    });
    expect(r.res.isError).toBe(true);
    const ok = await run('gm_document', client, {
      action: 'update',
      documentType: 'Actor',
      data: { _id: ID(1), name: 'X' },
    });
    expect(ok.text).toContain('Updated 1 Actor');
  });
  it('gm_document get filters embedded results by query', async () => {
    const { client } = makeClient();
    (client as unknown as { gmGet: ReturnType<typeof vi.fn> }).gmGet.mockResolvedValueOnce([
      { _id: 'a', ds: 0 },
      { _id: 'b', ds: 2 },
    ]);
    const r = await run('gm_document', client, {
      action: 'get',
      documentType: 'Wall',
      parentType: 'Scene',
      parentId: ID(10),
      query: { _id: 'b' },
    });
    expect(r.text).toContain('1 Wall document(s)');
  });
});

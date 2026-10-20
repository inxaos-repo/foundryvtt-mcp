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
  it('gm_document update accepts updates as an alias of data, and id for a single object', async () => {
    const { client, gmModify } = makeClient();
    const a = await run('gm_document', client, {
      action: 'update',
      documentType: 'Actor',
      updates: [{ _id: ID(1), name: 'A' }],
    });
    expect(a.text).toContain('Updated 1 Actor');
    const b = await run('gm_document', client, {
      action: 'update',
      documentType: 'Actor',
      id: ID(1),
      data: { name: 'B' },
    });
    expect(b.text).toContain('Updated 1 Actor');
    expect(gmModify).toHaveBeenLastCalledWith(
      'Actor',
      'update',
      expect.objectContaining({ updates: [{ name: 'B', _id: ID(1) }] }),
    );
  });
  it('gm_document sends token position updates as movements', async () => {
    const { client, gmModify } = makeClient();
    await run('gm_document', client, {
      action: 'update',
      documentType: 'Token',
      parentType: 'Scene',
      parentId: ID(10),
      data: [
        { _id: ID(61), x: 300 },
        { _id: ID(60), 'texture.tint': '#ff0000' },
      ],
    });
    expect(gmModify).toHaveBeenCalledWith(
      'Token',
      'update',
      expect.objectContaining({
        updates: [{ _id: ID(60), 'texture.tint': '#ff0000' }],
        diff: true,
      }),
    );
    expect(gmModify).toHaveBeenCalledWith(
      'Token',
      'update',
      expect.objectContaining({
        updates: [expect.objectContaining({ _id: ID(61), x: 300, y: 100 })],
        diff: false,
        _movement: { [ID(61)]: expect.objectContaining({ method: 'api' }) },
      }),
    );
  });
});

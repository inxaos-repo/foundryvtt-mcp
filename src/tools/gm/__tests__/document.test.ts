import { describe, expect, it, type vi } from 'vitest';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

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

describe('gm_document script macro guard', () => {
  const withEnv = async (value: string | undefined, fn: () => Promise<void>) => {
    const prev = process.env.FOUNDRY_ALLOW_SCRIPT_MACROS;
    if (value === undefined) {
      delete process.env.FOUNDRY_ALLOW_SCRIPT_MACROS;
    } else {
      process.env.FOUNDRY_ALLOW_SCRIPT_MACROS = value;
    }
    try {
      await fn();
    } finally {
      if (prev === undefined) {
        delete process.env.FOUNDRY_ALLOW_SCRIPT_MACROS;
      } else {
        process.env.FOUNDRY_ALLOW_SCRIPT_MACROS = prev;
      }
    }
  };
  const macroWorld = () => {
    const w = makeWorld() as ReturnType<typeof makeWorld> & { macros: unknown[] };
    w.macros = [
      { _id: ID(80), name: 'Say hi', type: 'chat', command: 'hi' },
      { _id: ID(81), name: 'Code', type: 'script', command: 'console.log(1)' },
    ];
    return w;
  };

  it('refuses to create script macros by default but allows chat macros', async () => {
    await withEnv(undefined, async () => {
      const { client, gmModify } = makeClient(macroWorld());
      const bad = await run('gm_document', client, {
        action: 'create',
        documentType: 'Macro',
        data: { name: 'x', type: 'script', command: 'alert(1)' },
      });
      expect(bad.res.isError).toBe(true);
      expect(bad.text).toContain('FOUNDRY_ALLOW_SCRIPT_MACROS');
      expect(gmModify).not.toHaveBeenCalled();
      const good = await run('gm_document', client, {
        action: 'create',
        documentType: 'Macro',
        data: { name: 'y', type: 'chat', command: '/roll 1d20' },
      });
      expect(good.text).toContain('Created 1 Macro');
    });
  });

  it('refuses updates that turn a macro into a script or edit a script macro', async () => {
    await withEnv('false', async () => {
      const { client } = makeClient(macroWorld());
      const toScript = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(80), type: 'script' },
      });
      expect(toScript.res.isError).toBe(true);
      const editScript = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(81), command: 'evil()' },
      });
      expect(editScript.res.isError).toBe(true);
      const unknown = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(89), command: 'x' },
      });
      expect(unknown.res.isError).toBe(true);
      // Renaming a script macro and editing a chat macro are fine.
      const rename = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(81), name: 'Renamed' },
      });
      expect(rename.text).toContain('Updated 1 Macro');
      const chat = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(80), command: '/roll 2d6' },
      });
      expect(chat.text).toContain('Updated 1 Macro');
    });
  });

  it('allows script macros when FOUNDRY_ALLOW_SCRIPT_MACROS=true', async () => {
    await withEnv('true', async () => {
      const { client } = makeClient(macroWorld());
      const r = await run('gm_document', client, {
        action: 'create',
        documentType: 'Macro',
        data: { name: 'x', type: 'script', command: 'ui.notifications.info(1)' },
      });
      expect(r.text).toContain('Created 1 Macro');
      const u = await run('gm_document', client, {
        action: 'update',
        documentType: 'Macro',
        data: { _id: ID(81), command: 'y()' },
      });
      expect(u.text).toContain('Updated 1 Macro');
    });
  });
});

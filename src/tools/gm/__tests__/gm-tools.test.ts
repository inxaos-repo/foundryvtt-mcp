import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { getAllTools } from '../../definitions.js';
import { toolRegistry } from '../../registry.js';
import { findBlockingWalls, segmentsIntersect } from '../geometry.js';
import { gmToolSpecs, gmTools } from '../index.js';

const ID = (n: number): string => `id${String(n).padStart(14, '0')}`;

function makeWorld() {
  return {
    userId: 'gmbot00000000001',
    users: [
      { _id: 'gmbot00000000001', name: 'gm-bot', role: 3 },
      { _id: 'gm00000000000001', name: 'Gamemaster', role: 4 },
      { _id: 'player0000000001', name: 'Alice', role: 1, character: ID(1) },
    ],
    activeUsers: ['player0000000001'],
    actors: [
      {
        _id: ID(1),
        name: 'Test Fighter',
        type: 'character',
        system: {
          hp: { value: 8, max: 10 },
          saves: { death: { value: 12 } },
          scores: { str: { value: 13 } },
          thac0: { value: 19 },
        },
        prototypeToken: { name: 'Fighter', sight: { enabled: false }, actorLink: true },
        items: [{ _id: ID(9), name: 'Gold Pieces', system: { quantity: { value: 10 } } }],
        effects: [],
      },
      {
        _id: ID(2),
        name: 'Goblin',
        type: 'monster',
        system: { hp: { value: 4, max: 4 } },
        prototypeToken: { name: 'Goblin', actorLink: false },
      },
    ],
    scenes: [
      {
        _id: ID(10),
        name: 'Dungeon',
        active: true,
        grid: { size: 100 },
        environment: { darknessLevel: 0.4, globalLight: { enabled: false } },
        walls: [
          { _id: ID(20), c: [300, 0, 300, 1000], door: 1, ds: 0, move: 20 },
          { _id: ID(21), c: [600, 0, 600, 1000], door: 1, ds: 1, move: 20 },
          { _id: ID(22), c: [0, 500, 1000, 500], door: 0, move: 20 },
        ],
        lights: [{ _id: ID(30), x: 1, y: 1, hidden: false, config: { dim: 10 } }],
        notes: [{ _id: ID(40), x: 5, y: 5, entryId: ID(50), pageId: ID(51) }],
        tokens: [
          {
            _id: ID(60),
            name: 'Goblin',
            actorId: ID(2),
            x: 400,
            y: 100,
            hidden: true,
            width: 1,
            height: 1,
          },
          {
            _id: ID(61),
            name: 'Fighter',
            actorId: ID(1),
            x: 100,
            y: 100,
            width: 1,
            height: 1,
            actorLink: true,
          },
        ],
      },
    ],
    journal: [
      {
        _id: ID(50),
        name: 'Room 1',
        pages: [
          { _id: ID(51), name: 'Key', text: { content: '<p>Goblins <b>sleep</b> here.</p>' } },
        ],
      },
    ],
    combats: [] as Array<Record<string, unknown>>,
    messages: [
      {
        _id: ID(70),
        author: 'player0000000001',
        content: 'I attack!',
        rolls: [
          JSON.stringify({
            formula: '1d20',
            total: 14,
            terms: [{ faces: 20, results: [{ result: 14 }] }],
          }),
        ],
      },
    ],
    playlists: [],
    packs: [],
  };
}

function makeClient(w = makeWorld()) {
  const gmModify = vi.fn(async (_type: string, action: string, op: Record<string, unknown>) => {
    if (action === 'create') {
      return (op.data as Array<Record<string, unknown>>).map((d, i) => ({
        ...d,
        _id: d._id ?? ID(900 + i),
      }));
    }
    if (action === 'update') {
      return op.updates as unknown[];
    }
    return op.ids as unknown[];
  });
  const client = {
    getWorld: () => w,
    gmModify,
    gmGet: vi.fn(async () => []),
    gmEmit: vi.fn(async () => true),
  } as unknown as FoundryClient;
  return { client, gmModify, w };
}

async function run(name: string, client: FoundryClient, args: Record<string, unknown>) {
  const tool = gmTools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`no tool ${name}`);
  }
  const res = await tool.execute(args, { foundryClient: client });
  return { res, text: String(res.content[0]?.text ?? '') };
}

describe('gm toolkit wiring', () => {
  it('registers every gm tool and lists it', () => {
    const listed = new Set(getAllTools().map((t) => t.name));
    for (const spec of gmToolSpecs) {
      expect(toolRegistry.has(spec.name)).toBe(true);
      expect(listed.has(spec.name)).toBe(true);
    }
  });

  it('has no duplicate tool names', () => {
    const names = getAllTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every write tool mentions the write guard', () => {
    const readOnly = new Set([
      'get_scene_full',
      'list_doors',
      'get_fog_state',
      'get_note_page',
      'read_chat',
      'get_turn_order',
      'list_party',
      'lookup_rule',
      'gm_document',
    ]);
    for (const s of gmToolSpecs.filter((x) => !readOnly.has(x.name))) {
      expect(s.description).toContain('FOUNDRY_WRITE_ENABLED');
    }
  });

  it('surfaces the write-guard error from the client', async () => {
    const { client, gmModify } = makeClient();
    gmModify.mockRejectedValueOnce(
      new Error('Write operations are disabled (FOUNDRY_WRITE_ENABLED)'),
    );
    const { res, text } = await run('set_door_state', client, { wallId: ID(20), state: 'open' });
    expect(res.isError).toBe(true);
    expect(text).toContain('FOUNDRY_WRITE_ENABLED');
  });
});

describe('geometry', () => {
  it('detects crossings', () => {
    expect(
      segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    ).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 5, y: 5 }, { x: 6, y: 9 })).toBe(
      false,
    );
  });
  it('open doors and move=0 walls do not block', () => {
    const walls = makeWorld().scenes[0]?.walls ?? [];
    expect(
      findBlockingWalls(walls, { x: 150, y: 150 }, { x: 450, y: 150 }).map((w) => w._id),
    ).toEqual([ID(20)]);
    expect(findBlockingWalls(walls, { x: 450, y: 150 }, { x: 750, y: 150 })).toEqual([]);
  });
});

describe('scene tools', () => {
  it('get_scene_full reports doors, hidden tokens and darkness (no NaN)', async () => {
    const { client } = makeClient();
    const { text } = await run('get_scene_full', client, { sceneId: 'Dungeon' });
    expect(text).toContain('"darkness": 0.4');
    expect(text).toContain('"state": "closed"');
    expect(text).toContain('"journal": "Room 1"');
    expect(text).not.toContain('NaN');
    const s = await run('get_scene_full', client, { summary: true });
    expect(s.text).toContain('"hiddenTokens": 1');
    expect(s.text).not.toContain('"tokens": [');
  });

  it('duplicate_scene copies embedded docs without the source id', async () => {
    const { client, gmModify } = makeClient();
    const { text } = await run('duplicate_scene', client, { sceneId: ID(10), name: 'Copy' });
    const [type, action, op] = gmModify.mock.calls[0] as [
      string,
      string,
      { data: Array<Record<string, unknown>> },
    ];
    expect([type, action]).toEqual(['Scene', 'create']);
    expect(op.data[0]?._id).toBeUndefined();
    expect(op.data[0]?.name).toBe('Copy');
    expect(op.data[0]?.active).toBe(false);
    expect((op.data[0]?.walls as unknown[]).length).toBe(3);
    expect(text).toContain('"walls": 3');
  });

  it('activate_scene can pull players', async () => {
    const { client, gmModify } = makeClient();
    await run('activate_scene', client, { sceneId: 'Dungeon', pullPlayers: true });
    expect(gmModify).toHaveBeenCalledWith('Scene', 'update', {
      updates: [{ _id: ID(10), active: true }],
    });
    expect(
      (client as unknown as { gmEmit: { mock: { calls: unknown[] } } }).gmEmit.mock.calls,
    ).toHaveLength(3);
  });

  it('create_token uses the prototype token with vision', async () => {
    const { client, gmModify } = makeClient();
    await run('create_token', client, {
      actorId: 'Test Fighter',
      x: 200,
      y: 300,
      vision: true,
      hidden: false,
    });
    const op = gmModify.mock.calls[0]?.[2] as {
      data: Array<Record<string, unknown>>;
      parentUuid: string;
    };
    expect(op.parentUuid).toBe(`Scene.${ID(10)}`);
    expect(op.data[0]).toMatchObject({
      actorId: ID(1),
      x: 200,
      y: 300,
      actorLink: true,
      sight: { enabled: true },
    });
  });

  it('set_token_hidden reveals', async () => {
    const { client, gmModify } = makeClient();
    await run('set_token_hidden', client, { tokenIds: [ID(60)], hidden: false });
    expect(gmModify).toHaveBeenCalledWith(
      'Token',
      'update',
      expect.objectContaining({ updates: [{ _id: ID(60), hidden: false }] }),
    );
  });

  it('move_token_checked refuses through a closed door and allows through an open one', async () => {
    const { client, gmModify } = makeClient();
    const blocked = await run('move_token_checked', client, { tokenId: ID(61), dx: 3 });
    expect(blocked.text).toContain('Blocked');
    expect(gmModify).not.toHaveBeenCalled();
    const forced = await run('move_token_checked', client, { tokenId: ID(61), dx: 3, force: true });
    expect(forced.text).toContain('forced');
    const { client: c2, gmModify: g2, w } = makeClient();
    (w.scenes[0] as { walls: Array<{ ds?: number }> }).walls[0]!.ds = 1;
    await run('move_token_checked', c2, { tokenId: ID(61), x: 700, y: 100 });
    expect(g2).toHaveBeenCalledWith(
      'Token',
      'update',
      expect.objectContaining({ updates: [{ _id: ID(61), x: 700, y: 100 }] }),
    );
  });

  it('set_door_state rejects non-doors and maps states', async () => {
    const { client, gmModify } = makeClient();
    const bad = await run('set_door_state', client, { wallId: ID(22), state: 'open' });
    expect(bad.res.isError).toBe(true);
    await run('set_door_state', client, { wallId: ID(20), state: 'locked' });
    expect(gmModify).toHaveBeenCalledWith('Wall', 'update', {
      updates: [{ _id: ID(20), ds: 2 }],
      parentUuid: `Scene.${ID(10)}`,
    });
  });

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

  it('set_scene_darkness writes environment.darknessLevel', async () => {
    const { client, gmModify } = makeClient();
    await run('set_scene_darkness', client, { darkness: 0.75 });
    expect(gmModify).toHaveBeenCalledWith('Scene', 'update', {
      updates: [{ _id: ID(10), 'environment.darknessLevel': 0.75 }],
    });
  });

  it('get_note_page returns stripped text', async () => {
    const { client } = makeClient();
    const { text } = await run('get_note_page', client, { noteId: ID(40) });
    expect(text).toContain('Goblins sleep here.');
  });
});

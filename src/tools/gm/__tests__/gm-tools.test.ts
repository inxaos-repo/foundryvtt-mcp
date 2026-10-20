import { describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { getAllTools } from '../../definitions.js';
import { toolRegistry } from '../../registry.js';
import { advance, sortTurns } from '../combat-tools.js';
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
});

describe('combat tools', () => {
  it('turn sorting and advancing', () => {
    const order = sortTurns([
      { _id: 'a', name: 'A', initiative: 2 },
      { _id: 'b', name: 'B', initiative: 5 },
      { _id: 'c', name: 'C' },
    ]);
    expect(order.map((o) => o._id)).toEqual(['b', 'a', 'c']);
    expect(advance(1, 1, 2, 'next_turn')).toEqual({ round: 2, turn: 0 });
    expect(advance(2, 0, 2, 'previous_turn')).toEqual({ round: 1, turn: 1 });
    expect(advance(0, 0, 2, 'next_turn')).toEqual({ round: 1, turn: 0 });
  });
  it('start_encounter creates combat and combatants', async () => {
    const { client, gmModify } = makeClient();
    await run('start_encounter', client, { tokenIds: [ID(60), ID(61)] });
    expect(gmModify.mock.calls.map((c) => `${c[0]}:${c[1]}`)).toEqual([
      'Combat:create',
      'Combatant:create',
      'Combat:update',
    ]);
  });
});

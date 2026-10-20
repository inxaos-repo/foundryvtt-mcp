import { describe, expect, it } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import {
  canOpenDoor,
  findBlockingWalls,
  findGridPath,
  segmentsIntersect,
  wallSide,
  wallsCrossed,
} from '../geometry.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

describe('geometry', () => {
  it('one-way walls block only from the closed side', () => {
    const a = { x: 100, y: -1000 };
    const b = { x: 100, y: 1000 };
    expect(wallSide(a, b, { x: 50, y: 50 })).toBe(1);
    expect(wallSide(a, b, { x: 150, y: 50 })).toBe(2);
    const wall = { _id: 'w', c: [100, -1000, 100, 1000], dir: 1 };
    const opts = { size: 100, bounds: { x: -300, y: -300, width: 700, height: 700 } };
    expect(findGridPath([wall], { x: 50, y: 50 }, { x: 150, y: 50 }, opts)).not.toBeNull();
    expect(findGridPath([wall], { x: 150, y: 50 }, { x: 50, y: 50 }, opts)).toBeNull();
    expect(
      findGridPath([{ ...wall, dir: 0 }], { x: 50, y: 50 }, { x: 150, y: 50 }, opts),
    ).toBeNull();
  });
  it('canOpenDoor allows closed doors, locked/secret only when forced', () => {
    const d = (door: number, ds: number) => ({ _id: 'w', c: [0, 0, 0, 1], door, ds });
    expect(canOpenDoor(d(1, 0))).toBe(true);
    expect(canOpenDoor(d(1, 1))).toBe(false);
    expect(canOpenDoor(d(1, 2))).toBe(false);
    expect(canOpenDoor(d(2, 0))).toBe(false);
    expect(canOpenDoor(d(0, 0), true)).toBe(false);
    expect(canOpenDoor(d(1, 2), true)).toBe(true);
    expect(canOpenDoor(d(2, 0), true)).toBe(true);
  });
  it('wallsCrossed lists walls a polyline crosses in order', () => {
    const a = { _id: 'a', c: [100, 0, 100, 100] };
    const b = { _id: 'b', c: [0, 200, 300, 200] };
    const c = { _id: 'c', c: [500, 0, 500, 100] };
    const hit = wallsCrossed(
      [b, a, c],
      [
        { x: 50, y: 50 },
        { x: 150, y: 50 },
        { x: 150, y: 250 },
      ],
    );
    expect(hit.map((w) => w._id)).toEqual(['a', 'b']);
  });
  it('findGridPath routes around a wall through a gap and refuses an enclosed goal', () => {
    // A wall across the map with a one-square gap at the bottom.
    const walls = [{ _id: 'w1', c: [300, 0, 300, 400], move: 20 }];
    const bounds = { x: 0, y: 0, width: 600, height: 600 };
    const path = findGridPath(walls, { x: 150, y: 150 }, { x: 450, y: 150 }, { size: 100, bounds });
    expect(path).not.toBeNull();
    expect(path?.points.length).toBeGreaterThan(2);
    expect(path?.steps).toBeGreaterThanOrEqual(5);
    const box = [
      { _id: 'n', c: [400, 100, 500, 100], move: 20 },
      { _id: 'e', c: [500, 100, 500, 200], move: 20 },
      { _id: 's', c: [400, 200, 500, 200], move: 20 },
      { _id: 'd', c: [400, 100, 400, 200], move: 20, door: 1, ds: 0 },
    ];
    expect(
      findGridPath(box, { x: 150, y: 150 }, { x: 450, y: 150 }, { size: 100, bounds }),
    ).toBeNull();
    // Opening the door makes it reachable.
    const open = box.map((w) => (w._id === 'd' ? { ...w, ds: 1 } : w));
    expect(
      findGridPath(open, { x: 150, y: 150 }, { x: 450, y: 150 }, { size: 100, bounds }),
    ).not.toBeNull();
  });

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
  it('get_scene_full warns about player tokens on the default white icon', async () => {
    const w = makeWorld();
    const tok = (w.scenes[0] as { tokens: Array<Record<string, unknown>> }).tokens.find(
      (t) => t._id === ID(61),
    ) as Record<string, unknown>;
    tok.texture = { src: 'icons/svg/mystery-man.svg' };
    const { client } = makeClient(w);
    const { text } = await run('get_scene_full', client, { sceneId: 'Dungeon', summary: true });
    expect(text).toContain('default mystery-man icon');
    tok.texture = { src: 'icons/svg/mystery-man.svg', tint: '#ff2020' };
    const again = await run('get_scene_full', client, { sceneId: 'Dungeon', summary: true });
    expect(again.text).not.toContain('mystery-man');
  });

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
  function emitCalls(client: FoundryClient): unknown[][] {
    return (client as unknown as { gmEmit: { mock: { calls: unknown[][] } } }).gmEmit.mock.calls;
  }

  it('activate_scene activates an inactive scene and re-pulls players that do not confirm', async () => {
    vi.useFakeTimers();
    try {
      const w = makeWorld();
      (w.scenes[0] as { active: boolean }).active = false;
      const { client, gmModify } = makeClient(w);
      (client.waitForViewedScene as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const p = run('activate_scene', client, { sceneId: 'Dungeon' });
      await vi.runAllTimersAsync();
      const { text } = await p;
      expect(gmModify).toHaveBeenCalledWith('Scene', 'update', {
        updates: [{ _id: ID(10), active: true }],
      });
      // Only the role-1 user is pulled; roles 3 (assistant) and 4 count as GMs.
      expect(emitCalls(client)).toEqual([
        ['pullToScene', ID(10), 'player0000000001', {}],
        ['pullToScene', ID(10), 'player0000000001', {}],
      ]);
      expect(text).toContain('pulled 1 user(s)');
      expect(text).toContain('1 online but not confirmed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('activate_scene on an already-active scene still pulls players', async () => {
    vi.useFakeTimers();
    try {
      const { client, gmModify } = makeClient();
      const p = run('activate_scene', client, { sceneId: 'Dungeon', includeGMs: true });
      await vi.runAllTimersAsync();
      const { text } = await p;
      expect(gmModify).not.toHaveBeenCalled();
      // Three targets, one online; it confirms, so nobody is pulled twice.
      expect(emitCalls(client)).toHaveLength(3);
      expect(text).toContain('Already active');
      expect(text).toContain('1 confirmed on scene; 2 offline');
    } finally {
      vi.useRealTimers();
    }
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
      expect.objectContaining({
        updates: [expect.objectContaining({ _id: ID(61), x: 700, y: 100 })],
        diff: false,
        _movement: { [ID(61)]: expect.objectContaining({ method: 'api' }) },
      }),
    );
  });
  it('move_token_checked openDoors opens a closed unlocked door on the route', async () => {
    const { client, gmModify } = makeClient();
    const r = await run('move_token_checked', client, {
      tokenId: ID(61),
      x: 400,
      y: 100,
      openDoors: true,
    });
    expect(r.text).toContain(`opened door(s) ${ID(20)}`);
    expect(gmModify.mock.calls[0]?.slice(0, 2)).toEqual(['Wall', 'update']);
    expect(gmModify.mock.calls[0]?.[2]).toMatchObject({
      parentUuid: `Scene.${ID(10)}`,
      updates: [{ _id: ID(20), ds: 1 }],
    });
    expect(gmModify.mock.calls[1]?.slice(0, 2)).toEqual(['Token', 'update']);
  });
  it('move_token_checked openDoors leaves locked and secret doors shut unless forceDoors', async () => {
    for (const door of [
      { door: 1, ds: 2 },
      { door: 2, ds: 0 },
    ]) {
      const { client, gmModify, w } = makeClient();
      Object.assign((w.scenes[0] as { walls: object[] }).walls[0]!, door);
      const r = await run('move_token_checked', client, {
        tokenId: ID(61),
        x: 400,
        y: 100,
        openDoors: true,
      });
      expect(r.text).toContain('Blocked');
      expect(gmModify).not.toHaveBeenCalled();
      const f = await run('move_token_checked', client, {
        tokenId: ID(61),
        x: 400,
        y: 100,
        openDoors: true,
        forceDoors: true,
      });
      expect(f.text).toContain('opened door(s)');
    }
  });
  it('move_token_checked prefers a route that needs no door', async () => {
    const { client, gmModify, w } = makeClient();
    // Shorten the closed door so there is a way round it.
    (w.scenes[0] as { walls: Array<{ c: number[] }> }).walls[0]!.c = [300, 0, 300, 400];
    const r = await run('move_token_checked', client, {
      tokenId: ID(61),
      x: 400,
      y: 100,
      openDoors: true,
    });
    expect(r.text).not.toContain('opened door');
    expect(gmModify).toHaveBeenCalledTimes(1);
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

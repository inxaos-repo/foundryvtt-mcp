import { describe, expect, it } from 'vitest';
import { findBlockingWalls, segmentsIntersect } from '../geometry.js';
import { ID, makeClient, makeWorld, run } from './fixtures.js';

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

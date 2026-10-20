import {
  bool,
  embedded,
  findByIdOrName,
  GmToolError,
  getActor,
  getPath,
  getScene,
  num,
  type Obj,
  ok,
  resolveUserIds,
  str,
  strList,
  target,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './spec.js';

// ---------------------------------------------------------------------------
// HP / actor helpers
// ---------------------------------------------------------------------------

const HP_PATHS = ['system.hp', 'system.attributes.hp'];

function hpPath(actor: Obj): string {
  const p = HP_PATHS.find((path) => typeof getPath(actor, `${path}.value`) === 'number');
  if (!p) {
    throw new GmToolError('Actor has no recognisable HP field (system.hp or system.attributes.hp)');
  }
  return p;
}

export const actorTools: GmToolSpec[] = [
  {
    name: 'apply_damage',
    description:
      'Change HP: positive amount = damage, negative = healing, or set=N for an exact value. Clamped to 0..max. Works on linked actors and unlinked tokens (token delta).' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        actorId: { type: 'string' },
        sceneId: { type: 'string' },
        amount: { type: 'number', description: 'Damage (negative heals)' },
        set: { type: 'number', description: 'Set HP to exactly this' },
      },
    },
    async run(client, args) {
      const t = target(client, args);
      const path = hpPath(t.actor);
      const delta = (t.token?.delta ?? {}) as Obj;
      const max = Number(
        getPath(delta, `${path}.max`) ?? getPath(t.actor, `${path}.max`) ?? Infinity,
      );
      const cur = Number(
        (t.unlinked ? getPath(delta, `${path}.value`) : undefined) ??
          getPath(t.actor, `${path}.value`),
      );
      const set = num(args, 'set', false);
      const amount = num(args, 'amount', false);
      if (set === undefined && amount === undefined) {
        throw new GmToolError('Pass amount or set');
      }
      const next = Math.max(0, Math.min(max, set ?? cur - (amount as number)));
      if (t.unlinked && t.token && t.sceneId) {
        await client.gmModify('Token', 'update', {
          updates: [{ _id: t.token._id, [`delta.${path}.value`]: next }],
          parentUuid: `Scene.${t.sceneId}`,
          diff: true,
        });
      } else {
        await client.gmModify('Actor', 'update', {
          updates: [{ _id: t.actor._id, [`${path}.value`]: next }],
          diff: true,
        });
      }
      const name = t.token?.name ?? t.actor.name;
      return ok(
        `❤️ ${name}: ${cur} → ${next}/${Number.isFinite(max) ? max : '?'}${next === 0 ? ' (down!)' : ''}`,
        { before: cur, after: next, max },
      );
    },
  },
  {
    name: 'set_condition',
    description:
      'Add or remove a condition / status effect (e.g. "dead", "prone", "blind", "poison") on an actor or token as an ActiveEffect with that status id. Lists current statuses.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        actorId: { type: 'string' },
        sceneId: { type: 'string' },
        statusId: { type: 'string' },
        active: { type: 'boolean' },
        label: { type: 'string', description: 'Display name (default statusId)' },
        icon: { type: 'string', description: 'Icon path (default icons/svg/aura.svg)' },
      },
      required: ['statusId', 'active'],
    },
    async run(client, args) {
      const t = target(client, args);
      const statusId = str(args, 'statusId') as string;
      const active = bool(args, 'active') as boolean;
      if (t.unlinked && t.token) {
        throw new GmToolError(
          'Token is unlinked: conditions on token deltas are not supported yet — use the actor (actorId) or link the token',
        );
      }
      const effects = embedded(t.actor, 'effects');
      const existing = effects.filter((e) => ((e.statuses as string[]) ?? []).includes(statusId));
      const parentUuid = `Actor.${t.actor._id}`;
      if (active && !existing.length) {
        await client.gmModify('ActiveEffect', 'create', {
          parentUuid,
          data: [
            {
              name: str(args, 'label', false) ?? statusId,
              img: str(args, 'icon', false) ?? 'icons/svg/aura.svg',
              statuses: [statusId],
            },
          ],
        });
      } else if (!active && existing.length) {
        await client.gmModify('ActiveEffect', 'delete', {
          parentUuid,
          ids: existing.map((e) => String(e._id)),
        });
      }
      const now = embedded(getActor(client, t.actor._id), 'effects').flatMap(
        (e) => (e.statuses as string[]) ?? [],
      );
      return ok(`🩹 ${t.actor.name}: ${statusId} ${active ? 'on' : 'off'}`, { statuses: now });
    },
  },
  {
    name: 'adjust_item_quantity',
    description:
      'Change the quantity of an item an actor owns (ammo, rations, coins — OSE currency is treasure items like "Gold Pieces"). delta adds/subtracts; creates nothing; use create_actor_item to add new items.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string' },
        item: { type: 'string', description: 'Item id or name' },
        delta: { type: 'number' },
        set: { type: 'number' },
        deleteAtZero: { type: 'boolean' },
      },
      required: ['actorId', 'item'],
    },
    async run(client, args) {
      const actor = getActor(client, str(args, 'actorId') as string);
      const item = findByIdOrName(
        embedded(actor, 'items') as Array<Obj & { _id: string; name?: string }>,
        str(args, 'item') as string,
        'Item',
      );
      const q = getPath(item, 'system.quantity');
      const path =
        typeof q === 'object' && q !== null ? 'system.quantity.value' : 'system.quantity';
      const cur = Number(getPath(item, path) ?? 0);
      const set = num(args, 'set', false);
      const delta = num(args, 'delta', false);
      if (set === undefined && delta === undefined) {
        throw new GmToolError('Pass delta or set');
      }
      const next = Math.max(0, set ?? cur + (delta as number));
      if (next === 0 && bool(args, 'deleteAtZero', false)) {
        await client.gmModify('Item', 'delete', {
          ids: [item._id],
          parentUuid: `Actor.${actor._id}`,
        });
        return ok(`🎒 ${actor.name}: ${item.name} used up (deleted)`);
      }
      await client.gmModify('Item', 'update', {
        updates: [{ _id: item._id, [path]: next }],
        parentUuid: `Actor.${actor._id}`,
        diff: true,
      });
      return ok(`🎒 ${actor.name}: ${item.name} ${cur} → ${next}`);
    },
  },
  {
    name: 'share_journal',
    description:
      'Show a journal entry or page to players (pops it open on their screens), or share an image URL/path. Defaults to all players.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        journalId: { type: 'string', description: 'Journal entry id or name' },
        pageId: { type: 'string', description: 'Page id or name within the entry' },
        image: { type: 'string', description: 'Share this image instead (path or URL)' },
        title: { type: 'string' },
        userIds: { type: 'array', items: { type: 'string' } },
      },
    },
    async run(client, args) {
      const users = resolveUserIds(client, strList(args, 'userIds'));
      const image = str(args, 'image', false);
      if (image) {
        await client.gmEmit('shareImage', {
          image,
          title: str(args, 'title', false) ?? '',
          ...(users.length ? { users } : {}),
        });
        return ok(`🖼️ Shared image ${image}`);
      }
      const j = findByIdOrName(
        world(client).journal as unknown as Array<Obj & { _id: string; name: string }>,
        str(args, 'journalId') as string,
        'JournalEntry',
      );
      let uuid = `JournalEntry.${j._id}`;
      const pageKey = str(args, 'pageId', false);
      let label = j.name;
      if (pageKey) {
        const p = findByIdOrName(
          embedded(j, 'pages') as Array<Obj & { _id: string; name?: string }>,
          pageKey,
          'Page',
        );
        uuid += `.JournalEntryPage.${p._id}`;
        label += ` › ${p.name}`;
      }
      await client.gmEmit('showEntry', uuid, { force: true, ...(users.length ? { users } : {}) });
      return ok(`📖 Showed "${label}" to ${users.length || 'all'} player(s)`, { uuid });
    },
  },
  {
    name: 'control_audio',
    description:
      'Play or stop a playlist (all its tracks per its mode) or a single track, or turn a scene ambient sound on/off.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['play', 'stop'] },
        playlist: { type: 'string', description: 'Playlist id or name' },
        track: { type: 'string', description: 'Track (PlaylistSound) id or name' },
        ambientSoundId: {
          type: 'string',
          description: 'Scene AmbientSound id (instead of playlist)',
        },
        sceneId: { type: 'string' },
      },
      required: ['action'],
    },
    async run(client, args) {
      const play = str(args, 'action') === 'play';
      const amb = str(args, 'ambientSoundId', false);
      if (amb) {
        const scene = getScene(client, str(args, 'sceneId', false));
        await client.gmModify('AmbientSound', 'update', {
          updates: [{ _id: amb, hidden: !play }],
          parentUuid: `Scene.${scene._id}`,
        });
        return ok(`🔊 Ambient sound ${amb} ${play ? 'on' : 'off'}`);
      }
      const pl = findByIdOrName(
        ((world(client) as unknown as Obj).playlists ?? []) as Array<
          Obj & { _id: string; name: string }
        >,
        str(args, 'playlist') as string,
        'Playlist',
      );
      const sounds = embedded(pl, 'sounds') as Array<Obj & { _id: string; name?: string }>;
      const trackKey = str(args, 'track', false);
      let chosen = sounds;
      if (trackKey) {
        chosen = [findByIdOrName(sounds, trackKey, 'Track')];
      } else if (play && pl.mode !== 1) {
        chosen = sounds.slice(0, 1); // sequential/shuffle: start with the first track
      }
      if (!play && !trackKey) {
        chosen = sounds.filter((s) => s.playing);
      }
      if (chosen.length) {
        await client.gmModify('PlaylistSound', 'update', {
          updates: chosen.map((s) => ({
            _id: s._id,
            playing: play,
            ...(play ? { pausedTime: 0 } : {}),
          })),
          parentUuid: `Playlist.${pl._id}`,
        });
      }
      const anyPlaying = play || sounds.some((s) => s.playing && !chosen.includes(s));
      await client.gmModify('Playlist', 'update', {
        updates: [{ _id: pl._id, playing: anyPlaying }],
      });
      return ok(
        `🎵 ${play ? 'Playing' : 'Stopped'} ${pl.name}${chosen.length ? `: ${chosen.map((s) => s.name).join(', ')}` : ''}`,
      );
    },
  },
  {
    name: 'list_party',
    description:
      'List users with role, online status and assigned character (actor) — who is playing whom.',
    inputSchema: { type: 'object', properties: {} },
    async run(client) {
      const w = world(client);
      const online = new Set((w as unknown as { activeUsers?: string[] }).activeUsers ?? []);
      const actors = w.actors as unknown as Obj[];
      const roles = ['none', 'player', 'trusted', 'assistant GM', 'gamemaster'];
      const rows = (w.users ?? []).map((u) => ({
        id: u._id,
        name: u.name,
        role: roles[u.role ?? 0] ?? String(u.role),
        online: online.has(u._id),
        character: u.character
          ? { id: u.character, name: actors.find((a) => a._id === u.character)?.name }
          : null,
      }));
      return ok(`👥 ${rows.filter((r) => r.online).length}/${rows.length} online`, rows);
    },
  },
  {
    name: 'import_from_compendium',
    description:
      'Import an Actor/Item/JournalEntry/RollTable from a compendium pack into the world (by entry id or name), optionally placing an actor as a token on a scene.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'Pack id, e.g. "ose.monsters" or "world.my-pack"' },
        entry: { type: 'string', description: 'Entry id or name' },
        folder: { type: 'string', description: 'World folder id' },
        place: {
          type: 'object',
          description: 'Actors only: place a token',
          properties: {
            sceneId: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            hidden: { type: 'boolean' },
          },
        },
        reuseExisting: {
          type: 'boolean',
          description: 'Reuse a world actor already imported from this entry (default true)',
        },
      },
      required: ['pack', 'entry'],
    },
    async run(client, args) {
      const pack = str(args, 'pack') as string;
      const w = world(client);
      const meta = ((w as unknown as Obj).packs as Obj[] | undefined)?.find(
        (p) => p.id === pack || `${p.packageName}.${p.name}` === pack,
      );
      const type = String(meta?.type ?? meta?.documentName ?? 'Actor');
      const key = str(args, 'entry') as string;
      const index = (await client.gmGet(type, {
        pack,
        index: true,
        indexFields: ['name'],
      })) as Array<Obj & { _id: string; name: string }>;
      const hit = findByIdOrName(index, key, `${pack} entry`);
      const uuid = `Compendium.${pack}.${type}.${hit._id}`;
      const coll: Record<string, string> = {
        Actor: 'actors',
        Item: 'items',
        JournalEntry: 'journal',
        RollTable: 'tables',
      };
      const existing = bool(args, 'reuseExisting', true)
        ? (((w as unknown as Obj)[coll[type] ?? ''] as Obj[]) ?? []).find(
            (d) =>
              getPath(d, '_stats.compendiumSource') === uuid ||
              getPath(d, 'flags.core.sourceId') === uuid,
          )
        : undefined;
      let doc = existing;
      if (!doc) {
        const [src] = (await client.gmGet(type, { pack, query: { _id: hit._id } })) as Obj[];
        if (!src) {
          throw new GmToolError(`Could not load ${uuid}`);
        }
        const data = structuredClone(src);
        delete data._id;
        data._stats = { compendiumSource: uuid };
        const folder = str(args, 'folder', false);
        data.folder = folder ?? null;
        doc = ((await client.gmModify(type, 'create', { data: [data] })) as Obj[])[0];
      }
      if (!doc) {
        throw new GmToolError('Import failed');
      }
      let placed = '';
      const place = args.place as Obj | undefined;
      if (place && type === 'Actor') {
        const scene = getScene(client, str(place, 'sceneId', false));
        const proto = structuredClone((doc.prototypeToken ?? {}) as Obj);
        delete proto.randomImg;
        const [tok] = (await client.gmModify('Token', 'create', {
          parentUuid: `Scene.${scene._id}`,
          data: [
            {
              ...proto,
              name: proto.name ?? doc.name,
              actorId: doc._id,
              x: num(place, 'x'),
              y: num(place, 'y'),
              hidden: bool(place, 'hidden', false),
            },
          ],
        })) as Obj[];
        placed = ` and placed token ${tok?._id} on "${scene.name}"`;
      }
      return ok(
        `📦 ${existing ? 'Reused' : 'Imported'} ${type} "${doc.name}" (${doc._id})${placed}`,
        { id: doc._id, uuid },
      );
    },
  },
];

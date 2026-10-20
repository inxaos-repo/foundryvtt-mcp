import {
  embedded,
  findByIdOrName,
  getScene,
  type Obj,
  ok,
  resolveUserIds,
  str,
  strList,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

export const mediaTools: GmToolSpec[] = [
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
];

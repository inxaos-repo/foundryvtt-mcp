import {
  bool,
  findByIdOrName,
  GmToolError,
  getPath,
  getScene,
  num,
  type Obj,
  ok,
  str,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

export const compendiumTools: GmToolSpec[] = [
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

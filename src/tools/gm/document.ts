import { GmToolError, type Obj, ok, str, strList } from './helpers.js';
import type { GmToolSpec } from './tool-spec.js';

/** Document types gm_document may touch, with their parent (if embedded). */
export const DOCUMENT_TYPES: Record<string, { parent?: string[] }> = {
  Scene: {},
  Actor: {},
  Item: { parent: ['Actor'] },
  JournalEntry: {},
  JournalEntryPage: { parent: ['JournalEntry'] },
  RollTable: {},
  TableResult: { parent: ['RollTable'] },
  Combat: {},
  Combatant: { parent: ['Combat'] },
  ChatMessage: {},
  Playlist: {},
  PlaylistSound: { parent: ['Playlist'] },
  Folder: {},
  Macro: {},
  Token: { parent: ['Scene'] },
  Wall: { parent: ['Scene'] },
  AmbientLight: { parent: ['Scene'] },
  AmbientSound: { parent: ['Scene'] },
  Note: { parent: ['Scene'] },
  Tile: { parent: ['Scene'] },
  Drawing: { parent: ['Scene'] },
  Region: { parent: ['Scene'] },
  MeasuredTemplate: { parent: ['Scene'] },
  ActiveEffect: { parent: ['Actor', 'Item'] },
  FogExploration: {},
};

export const documentTools: GmToolSpec[] = [
  {
    name: 'gm_document',
    description:
      'Generic create/update/delete/get for any Foundry document or embedded document (Scene, Token, Wall, AmbientLight, AmbientSound, Note, Tile, Drawing, Region, Actor, Item, ActiveEffect, JournalEntry, JournalEntryPage, RollTable, Combat, Combatant, ChatMessage, Playlist, PlaylistSound…). Use the specific tools first; this is the escape hatch. Embedded types need parentType+parentId. update takes data (or its alias updates): object(s) each with _id, or a single object plus id; delete needs ids. Writes require FOUNDRY_WRITE_ENABLED=true.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'create', 'update', 'delete'] },
        documentType: { type: 'string', enum: Object.keys(DOCUMENT_TYPES) },
        parentType: {
          type: 'string',
          description: 'Parent document type for embedded docs (Scene, Actor, Combat…)',
        },
        parentId: { type: 'string', description: 'Parent document id for embedded docs' },
        data: {
          description:
            'create: object or array of objects; update: object(s) each with _id (dot-notation keys allowed)',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
        updates: {
          description: 'update: alias for data (object or array of objects with _id)',
          oneOf: [{ type: 'object' }, { type: 'array', items: { type: 'object' } }],
        },
        id: {
          type: 'string',
          description: 'update: id of the document when data is a single object without _id',
        },
        ids: { type: 'array', items: { type: 'string' }, description: 'delete: ids to delete' },
        query: {
          type: 'object',
          description: 'get: field filter, e.g. {"_id":"..."} or {"scene":"..."}',
        },
        pack: {
          type: 'string',
          description: 'get: compendium pack id to read from instead of the world',
        },
      },
      required: ['action', 'documentType'],
    },
    async run(client, args) {
      const action = str(args, 'action') as 'get' | 'create' | 'update' | 'delete';
      const type = str(args, 'documentType') as string;
      const spec = DOCUMENT_TYPES[type];
      if (!spec) {
        throw new GmToolError(`Unsupported documentType ${type}`);
      }
      const parentType = str(args, 'parentType', false);
      const parentId = str(args, 'parentId', false);
      let parentUuid: string | undefined;
      if (spec.parent) {
        if (!parentType || !parentId) {
          throw new GmToolError(
            `${type} is embedded: pass parentType (${spec.parent.join('|')}) and parentId`,
          );
        }
        if (!spec.parent.includes(parentType)) {
          throw new GmToolError(`${type} parent must be ${spec.parent.join(' or ')}`);
        }
        parentUuid = `${parentType}.${parentId}`;
      }
      const base: Obj = parentUuid ? { parentUuid } : {};
      if (action === 'get') {
        const pack = str(args, 'pack', false);
        const query = (args.query as Obj) ?? {};
        let res = (await client.gmGet(type, {
          ...base,
          query,
          ...(pack ? { pack } : {}),
        })) as Obj[];
        // For embedded documents the server returns the parent's whole collection
        // and ignores `query`, so apply the filter locally.
        if (parentUuid) {
          res = res.filter((d) => Object.entries(query).every(([k, v]) => d[k] === v));
        }
        return ok(`📄 ${res.length} ${type} document(s)`, res.slice(0, 50));
      }
      if (action === 'delete') {
        const ids = strList(args, 'ids');
        if (!ids.length) {
          throw new GmToolError('delete needs ids');
        }
        const res = await client.gmModify(type, 'delete', { ...base, ids });
        return ok(`🗑️ Deleted ${res.length} ${type}`, res);
      }
      // `updates` mirrors the Foundry operation field name and is accepted as an
      // alias of `data` for updates.
      const raw = args.data ?? (action === 'update' ? args.updates : undefined);
      let list = (Array.isArray(raw) ? raw : raw ? [raw] : []) as Obj[];
      if (!list.length) {
        throw new GmToolError(
          action === 'update'
            ? 'update needs data (or updates): object(s) each with _id'
            : `${action} needs data`,
        );
      }
      const id = str(args, 'id', false);
      if (action === 'update' && id && list.length === 1 && list[0]?._id === undefined) {
        list = [{ ...(list[0] as Obj), _id: id }];
      }
      if (action === 'create') {
        const res = (await client.gmModify(type, 'create', { ...base, data: list })) as Obj[];
        return ok(
          `✅ Created ${res.length} ${type}: ${res.map((r) => `${r.name ?? ''} (${r._id})`).join(', ')}`,
          res.map((r) => ({ _id: r._id, name: r.name })),
        );
      }
      if (!list.every((d) => typeof d._id === 'string')) {
        throw new GmToolError('update data objects must each include _id');
      }
      // Token position changes must be sent as movements to render live.
      const res =
        type === 'Token' && parentType === 'Scene' && parentId
          ? await client.updateTokens(parentId, list)
          : await client.gmModify(type, 'update', { ...base, updates: list, diff: true });
      return ok(`✏️ Updated ${res.length} ${type}`, res);
    },
  },
];

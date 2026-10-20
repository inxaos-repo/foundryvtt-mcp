/**
 * User and party overview.
 */

import { type Obj, ok, world } from './helpers.js';
import type { GmToolSpec } from './tool-spec.js';

export const partyTools: GmToolSpec[] = [
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
];

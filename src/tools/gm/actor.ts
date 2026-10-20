/**
 * Actor state tools: hit points, conditions and inventory quantities.
 */

import {
  bool,
  embedded,
  findByIdOrName,
  GmToolError,
  getActor,
  getPath,
  num,
  type Obj,
  ok,
  resolveTarget,
  str,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

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
      const t = resolveTarget(client, args);
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
      const t = resolveTarget(client, args);
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
      'Change the quantity of an item an actor owns (ammo, rations, coins in systems that model currency as items). delta adds/subtracts; use create_actor_item to add new items.' +
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
];

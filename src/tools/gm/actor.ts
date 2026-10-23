import type { FoundryClient } from '../../foundry/client.js';

/**
 * Actor state tools: hit points, conditions and inventory quantities.
 */

import { bridgeRequest } from './covert-bridge.js';
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
  world,
} from './helpers.js';
import { COVERT_OPS_ID, covertArmor } from './systems/covert-ops.js';
import { getSystemAdapter } from './systems/registry.js';
import type { ConditionSupport } from './systems/types.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

// ---------------------------------------------------------------------------
// HP / actor helpers
// ---------------------------------------------------------------------------

const HP_PATHS = ['system.hp', 'system.attributes.hp'];

/** Icons of Foundry's core CONFIG.statusEffects, used when no icon is given. */
export const CORE_STATUS_ICONS: Record<string, string> = Object.fromEntries(
  Object.entries({
    dead: 'skull',
    unconscious: 'unconscious',
    sleep: 'sleep',
    stun: 'daze',
    prone: 'falling',
    restrain: 'net',
    paralysis: 'paralysis',
    fly: 'wing',
    blind: 'blind',
    deaf: 'deaf',
    silence: 'silenced',
    fear: 'terror',
    burning: 'fire',
    frozen: 'frozen',
    shock: 'lightning',
    corrode: 'acid',
    bleeding: 'blood',
    disease: 'biohazard',
    poison: 'poison',
    curse: 'sun',
    regen: 'regen',
    degen: 'degen',
    hover: 'wingfoot',
    burrow: 'mole',
    upgrade: 'upgrade',
    downgrade: 'downgrade',
    invisible: 'invisible',
    target: 'target',
    eye: 'eye',
    bless: 'angel',
  }).map(([id, f]) => [id, `icons/svg/${f}.svg`]),
);

type Target = ReturnType<typeof resolveTarget>;

function conditionSlug(i: Obj): string {
  const slug = getPath(i, 'system.slug');
  return typeof slug === 'string' && slug
    ? slug
    : String(i.name ?? '')
        .toLowerCase()
        .replace(/\s+/g, '-');
}

function conditionText(i: Obj): string {
  const v = getPath(i, 'system.value.value');
  return getPath(i, 'system.value.isValued') && typeof v === 'number'
    ? `${conditionSlug(i)} ${v}`
    : conditionSlug(i);
}

/**
 * Item-based conditions (PF2e): add the condition Item from the system's
 * compendium, set its value, or delete it. An unlinked token's own condition
 * items live on its ActorDelta.
 */
export async function setConditionItem(
  client: Parameters<GmToolSpec['run']>[0],
  t: Target,
  statusId: string,
  active: boolean,
  value: number | undefined,
  support: ConditionSupport,
): Promise<ReturnType<typeof ok>> {
  const slug = statusId.trim().toLowerCase().replace(/\s+/g, '-');
  const valued = support.valued.includes(slug);
  if (value !== undefined && !valued) {
    throw new GmToolError(`${slug} does not take a value`);
  }
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw new GmToolError('value must be a whole number ≥ 0');
  }
  const delta = t.unlinked && t.token ? ((t.token.delta ?? {}) as Obj) : undefined;
  const parentUuid = delta
    ? `Scene.${t.sceneId}.Token.${t.token?._id}.ActorDelta.${String(delta._id ?? t.token?._id)}`
    : `Actor.${t.actor._id}`;
  const own = (
    delta ? ((delta.items as Obj[] | undefined) ?? []) : embedded(t.actor, 'items')
  ).filter((i) => i.type === 'condition') as Obj[];
  const base = delta
    ? (embedded(t.actor, 'items') as Obj[]).filter((i) => i.type === 'condition')
    : [];
  const existing = own.filter((i) => conditionSlug(i) === slug);
  const remove = !active || value === 0;
  let after = own;
  if (remove) {
    if (existing.length) {
      const ids = existing.map((i) => String(i._id));
      await client.gmModify('Item', 'delete', { parentUuid, ids });
      after = own.filter((i) => !ids.includes(String(i._id)));
    } else if (base.some((i) => conditionSlug(i) === slug)) {
      throw new GmToolError(
        `${slug} comes from the base actor "${t.actor.name}" and applies to every token of it; remove it from the actor (actorId) instead`,
      );
    }
  } else if (existing.length) {
    const cur = existing[0] as Obj;
    if (valued && value !== undefined && getPath(cur, 'system.value.value') !== value) {
      await client.gmModify('Item', 'update', {
        parentUuid,
        updates: [{ _id: cur._id, 'system.value.value': value }],
      });
      after = own.map((i) =>
        i === cur
          ? {
              ...cur,
              system: {
                ...(cur.system as Obj),
                value: { ...(getPath(cur, 'system.value') as Obj), value },
              },
            }
          : i,
      );
    }
  } else {
    const docs = (await client.gmGet('Item', { pack: support.pack })) as Obj[];
    const src = docs.find((d) => d.type === 'condition' && conditionSlug(d) === slug);
    if (!src) {
      const known = docs
        .filter((d) => d.type === 'condition')
        .map(conditionSlug)
        .sort()
        .join(', ');
      throw new GmToolError(`Unknown condition "${statusId}". Known: ${known}`);
    }
    const { _id, folder: _folder, sort: _sort, ownership: _own, _stats, ...rest } = src;
    const data: Obj = {
      ...rest,
      _stats: { compendiumSource: `Compendium.${support.pack}.Item.${String(_id)}` },
    };
    if (valued) {
      data.system = {
        ...(rest.system as Obj),
        value: { ...(getPath(rest, 'system.value') as Obj), value: value ?? 1 },
      };
    }
    const res = (await client.gmModify('Item', 'create', { parentUuid, data: [data] })) as Obj[];
    after = [...own, ...(res[0] ? [res[0]] : [data])];
  }
  const now = [...after, ...base].map(conditionText);
  const who = t.token
    ? `${String(t.token.name ?? t.actor.name)}${delta ? ' (token)' : ''}`
    : t.actor.name;
  const shown = remove
    ? 'off'
    : valued
      ? `${value ?? getPath(existing[0], 'system.value.value') ?? 1}`
      : 'on';
  return ok(`🩹 ${who}: ${slug} ${shown}`, { conditions: now });
}

/**
 * Keeps combat state in step with HP: at 0 HP every combatant of the target
 * (that token, or for an actor every combatant of it) is marked defeated and
 * gets the core "dead" status; healing above 0 clears both. Returns the
 * combatant ids changed.
 */
export async function syncDefeated(
  client: FoundryClient,
  t: ReturnType<typeof resolveTarget>,
  down: boolean,
): Promise<string[]> {
  const changed: string[] = [];
  for (const c of (world(client).combats ?? []) as unknown as Obj[]) {
    const hits = ((c.combatants as Obj[] | undefined) ?? []).filter(
      (x) =>
        (t.token ? x.tokenId === t.token._id : x.actorId === t.actor._id) &&
        Boolean(x.defeated) !== down,
    );
    if (!hits.length) {
      continue;
    }
    await client.gmModify('Combatant', 'update', {
      updates: hits.map((x) => ({ _id: x._id, defeated: down })),
      parentUuid: `Combat.${String(c._id)}`,
    });
    changed.push(...hits.map((x) => String(x._id)));
  }
  if (!down && !changed.length) {
    return changed;
  }
  const setCondition = actorTools.find((x) => x.name === 'set_condition');
  try {
    await setCondition?.run(client, {
      ...(t.token ? { tokenId: t.token._id, sceneId: t.sceneId } : { actorId: t.actor._id }),
      statusId: 'dead',
      active: down,
    });
  } catch {
    // Status icon is cosmetic; the defeated flag above is what combat uses.
  }
  return changed;
}

function hpPath(actor: Obj): string {
  const p = HP_PATHS.find((path) => typeof getPath(actor, `${path}.value`) === 'number');
  if (!p) {
    throw new GmToolError('Actor has no recognisable HP field (system.hp or system.attributes.hp)');
  }
  return p;
}

/** Current value of a system field, preferring an unlinked token's delta. */
function readField(t: ReturnType<typeof resolveTarget>, path: string): number {
  const delta = (t.token?.delta ?? {}) as Obj;
  return Number((t.unlinked ? getPath(delta, path) : undefined) ?? getPath(t.actor, path) ?? 0);
}

/** Write system fields to the actor, or to the token delta when unlinked. */
export async function writeFields(
  client: FoundryClient,
  t: ReturnType<typeof resolveTarget>,
  fields: Record<string, number>,
): Promise<void> {
  if (t.unlinked && t.token && t.sceneId) {
    await client.gmModify('Token', 'update', {
      updates: [
        {
          _id: t.token._id,
          ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [`delta.${k}`, v])),
        },
      ],
      parentUuid: `Scene.${t.sceneId}`,
      diff: true,
    });
  } else {
    await client.gmModify('Actor', 'update', {
      updates: [{ _id: t.actor._id, ...fields }],
      diff: true,
    });
  }
}

/**
 * Fallback vitality/wounds damage for covert-ops-d20 when no GM browser is
 * connected to run the system's own rules (module/combat/damage.mjs via
 * module/bridge/derived-cache.mjs). Damage reduction (worn armor DR for the
 * attack kind, or the actor's DR override, minus AP) is applied first; a normal
 * hit comes off vitality (excess is lost); once vitality is 0, hits go to
 * wounds. toWounds (critical hits) goes straight to wounds. Negative amount
 * heals. Down at 0 wounds or fewer. Not modelled here: standard NPC Damage
 * saves, massive damage, subdual and stress (these need the GM browser).
 */
export function covertDR(t: ReturnType<typeof resolveTarget>, attack: string, ap: number): number {
  const delta = (t.token?.delta ?? {}) as Obj;
  const flags = (getPath(delta, `flags.${COVERT_OPS_ID}.combat`) ??
    getPath(t.actor, `flags.${COVERT_OPS_ID}.combat`) ??
    {}) as Obj;
  const items = (delta.items as Obj[] | undefined) ?? (t.actor.items as Obj[] | undefined) ?? [];
  const armor = covertArmor({ items });
  const override = flags.dr !== undefined && flags.dr !== null && flags.dr !== '';
  const base = override
    ? Number(flags.dr) || 0
    : attack === 'melee' || attack === 'ranged'
      ? armor.dr[attack]
      : (armor.dyn as number);
  return Math.max(0, base - Math.max(0, ap));
}

export async function applyCovertDamage(
  client: FoundryClient,
  t: ReturnType<typeof resolveTarget>,
  amount: number,
  toWounds: boolean,
  dr = 0,
) {
  const raw = amount;
  if (amount > 0) {
    amount = Math.max(0, amount - dr);
  }
  const vp = readField(t, 'system.vitality.value');
  // classes-mode agents store max 0; the GM client's derived cache has the real max.
  const derived = (getPath(t.token?.delta ?? {}, `flags.${COVERT_OPS_ID}.derived`) ??
    getPath(t.actor, `flags.${COVERT_OPS_ID}.derived`)) as Obj | undefined;
  const dMax = (k: string) => Number(getPath(derived, `${k}.max`) ?? 0);
  const vpMax = readField(t, 'system.vitality.max') || dMax('vitality');
  const wp = readField(t, 'system.wounds.value');
  const wpMax = readField(t, 'system.wounds.max') || dMax('wounds');
  let nv = vp;
  let nw = wp;
  if (amount < 0) {
    if (toWounds || vpMax <= 0) {
      nw = Math.min(wpMax, wp - amount);
    } else {
      nv = Math.min(vpMax, vp - amount);
    }
  } else if (toWounds || vpMax <= 0) {
    nw = wp - amount;
  } else {
    if (vp > 0) {
      nv = Math.max(0, vp - amount);
    } else {
      nw = wp - amount;
    }
  }
  await writeFields(client, t, { 'system.vitality.value': nv, 'system.wounds.value': nw });
  const down = nw <= 0;
  const defeated = down || wp <= 0 ? await syncDefeated(client, t, down) : [];
  const name = t.token?.name ?? t.actor.name;
  return ok(
    `❤️ ${name}: VP ${vp} → ${nv}/${vpMax}, WP ${wp} → ${nw}/${wpMax}${down ? ' (down!)' : ''}`,
    {
      vitality: { before: vp, after: nv, max: vpMax },
      wounds: { before: wp, after: nw, max: wpMax },
      down,
      defeated,
      ...(raw > 0 ? { raw, dr, rules: 'bridge fallback (no GM browser connected)' } : {}),
    },
  );
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
        toWounds: {
          type: 'boolean',
          description:
            'covert-ops-d20 only: damage goes straight to wounds (critical hit). Otherwise vitality, or wounds once vitality is 0 (excess is not carried over). Standard NPCs resolve damage with a Damage save (needs a GM browser connected).',
        },
        attack: {
          type: 'string',
          enum: ['melee', 'ranged'],
          description: 'covert-ops-d20: attack kind, selects worn armor DR (melee or ranged)',
        },
        ap: { type: 'number', description: 'covert-ops-d20: armor piercing (reduces DR)' },
        ignoreDR: { type: 'boolean', description: 'covert-ops-d20: skip damage reduction' },
        critDice: { type: 'number', description: 'covert-ops-d20: critical multiplier dice' },
        blast: { type: 'boolean', description: 'covert-ops-d20: blast damage' },
        damageType: {
          type: 'string',
          description: 'covert-ops-d20: damage type (lethal, subdual, stress, ...)',
        },
      },
    },
    async run(client, args) {
      const t = resolveTarget(client, args);
      if (String((world(client).system as Obj | undefined)?.id ?? '') === COVERT_OPS_ID) {
        const amount = num(args, 'amount', false);
        if (amount === undefined) {
          throw new GmToolError('covert-ops-d20: pass amount (negative heals)');
        }
        const toWounds = bool(args, 'toWounds', false) ?? false;
        const attack = str(args, 'attack', false) ?? '';
        const ap = num(args, 'ap', false) ?? 0;
        const ignoreDR = bool(args, 'ignoreDR', false) ?? false;
        if (amount > 0) {
          const res = await bridgeRequest(client, t, {
            op: 'damage',
            amount,
            attack,
            ap,
            ignoreDR,
            critical: toWounds,
            critDice: num(args, 'critDice', false) ?? 1,
            blast: bool(args, 'blast', false) ?? false,
            type: str(args, 'damageType', false) ?? '',
            label: t.token?.name ?? t.actor.name,
          });
          if (res) {
            if (!res.ok) {
              throw new GmToolError(
                `covert-ops-d20 damage rules failed: ${res.error ?? 'unknown'}`,
              );
            }
            const name = String(t.token?.name ?? t.actor.name);
            return ok(`❤️ ${name}: ${(res.lines ?? []).join(' ')}`, {
              lines: res.lines ?? [],
              damage: res.damage ?? 0,
              ouch: res.ouch ?? null,
              vitality: (res.derived as Obj | undefined)?.vitality,
              wounds: (res.derived as Obj | undefined)?.wounds,
              rules: 'system (GM browser)',
            });
          }
        }
        if (
          amount > 0 &&
          String(t.actor.type) === 'npc' &&
          readField(t, 'system.vitality.max') <= 0
        ) {
          throw new GmToolError(
            'covert-ops-d20: standard NPCs (no vitality) take damage through a Damage save, which needs a GM browser connected to Foundry (or use the damage card in Foundry)',
          );
        }
        return applyCovertDamage(
          client,
          t,
          amount,
          toWounds,
          ignoreDR ? 0 : covertDR(t, attack, ap),
        );
      }
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
      const defeated = await syncDefeated(client, t, next === 0);
      const name = t.token?.name ?? t.actor.name;
      return ok(
        `❤️ ${name}: ${cur} → ${next}/${Number.isFinite(max) ? max : '?'}${next === 0 ? ' (down!)' : ''}`,
        { before: cur, after: next, max, defeated },
      );
    },
  },
  {
    name: 'set_condition',
    description:
      'Add or remove a condition / status effect (e.g. "dead", "prone", "blind", "poison") on an actor or token as an ActiveEffect with that status id. Lists current statuses. In systems whose conditions are items (PF2e) the condition item is added from the system compendium instead, and valued conditions take value (frightened 2; value 0 removes).' +
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
        value: {
          type: 'number',
          description:
            'Value for valued conditions in systems that have them (PF2e frightened 2…); 0 removes',
        },
      },
      required: ['statusId', 'active'],
    },
    async run(client, args) {
      const t = resolveTarget(client, args);
      const statusId = str(args, 'statusId') as string;
      const active = bool(args, 'active') as boolean;
      const value = num(args, 'value', false);
      const systemId = String((world(client).system as Obj | undefined)?.id ?? '');
      const support = getSystemAdapter(systemId)?.conditions;
      if (support) {
        return setConditionItem(client, t, statusId, active, value, support);
      }
      if (value !== undefined) {
        throw new GmToolError(
          `System "${systemId || 'unknown'}" has no valued conditions; omit value`,
        );
      }
      // An unlinked token's synthetic actor stores its own effects on the
      // token's ActorDelta; the delta is the parent for creates/deletes.
      const delta = t.unlinked && t.token ? ((t.token.delta ?? {}) as Obj) : undefined;
      const parentUuid = delta
        ? `Scene.${t.sceneId}.Token.${t.token?._id}.ActorDelta.${String(delta._id ?? t.token?._id)}`
        : `Actor.${t.actor._id}`;
      const hasStatus = (e: Obj) => ((e.statuses as string[]) ?? []).includes(statusId);
      const ownEffects = (
        delta ? ((delta.effects as Obj[] | undefined) ?? []) : embedded(t.actor, 'effects')
      ) as Obj[];
      const baseEffects = delta ? (embedded(t.actor, 'effects') as Obj[]) : [];
      const existing = ownEffects.filter(hasStatus);
      const inherited = baseEffects.filter(hasStatus);
      let created: Obj | undefined;
      let removed: string[] = [];
      if (active && !existing.length && !inherited.length) {
        const res = await client.gmModify('ActiveEffect', 'create', {
          parentUuid,
          data: [
            {
              name: str(args, 'label', false) ?? statusId,
              img: str(args, 'icon', false) ?? CORE_STATUS_ICONS[statusId] ?? 'icons/svg/aura.svg',
              statuses: [statusId],
              // Without a duration Foundry treats the effect as permanent and
              // CONDITIONAL (the default) hides it from the token; status
              // conditions should always show on the token.
              showIcon: 2,
            },
          ],
        });
        created = res[0] as Obj | undefined;
      } else if (!active && existing.length) {
        removed = existing.map((e) => String(e._id));
        await client.gmModify('ActiveEffect', 'delete', { parentUuid, ids: removed });
      }
      if (!active && inherited.length) {
        throw new GmToolError(
          `${statusId} comes from the base actor "${t.actor.name}" and applies to every token of it; remove it from the actor (actorId) instead`,
        );
      }
      // Read back from the server's reply rather than the cache, which does not
      // track ActorDelta children.
      const statuses = new Set<string>(
        [
          ...ownEffects.filter((e) => !removed.includes(String(e._id))),
          ...baseEffects,
          ...(created ? [created] : []),
        ].flatMap((e) => (e.statuses as string[]) ?? []),
      );
      const now = [...statuses];
      const who = t.token
        ? `${String(t.token.name ?? t.actor.name)}${delta ? ' (token)' : ''}`
        : t.actor.name;
      return ok(`🩹 ${who}: ${statusId} ${active ? 'on' : 'off'}`, { statuses: now });
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

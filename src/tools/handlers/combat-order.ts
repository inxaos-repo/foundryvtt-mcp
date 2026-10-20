/**
 * @fileoverview Shared combatant turn-order helper (#214).
 *
 * FoundryVTT resolves `Combat#turn` against the **initiative-sorted** turn
 * order, not the stored (creation) order of `Combat#combatants`. Every handler
 * that maps a `turn` index onto a combatant — the read path
 * (`get_combat_state`) and the write path (`next_turn`) alike — must therefore
 * derive that list here, so the two can never drift apart through slightly
 * different comparators.
 *
 * The comparator mirrors core's `Combat._sortCombatants`: initiative
 * descending, non-numeric (un-rolled) initiative last, ties broken by document
 * id so the order is deterministic and stable.
 */

import type { WorldCombat, WorldData } from '../../foundry/types.js';

/** A single combatant embedded in a `WorldCombat` document. */
export type WorldCombatant = WorldCombat['combatants'][number];

/** Un-rolled / malformed initiative sorts to the very end of the order. */
function initiativeOf(c: WorldCombatant): number {
  return typeof c.initiative === 'number' && Number.isFinite(c.initiative)
    ? c.initiative
    : Number.NEGATIVE_INFINITY;
}

/**
 * World-derived facts a system-specific tie-break needs but that are not
 * stored on the combatant itself. Built once per call by
 * {@link turnOrderContext}; omit it to get core's comparator.
 */
export interface TurnOrderContext {
  /** Game system id (`world.system.id`), e.g. `ose`. */
  systemId?: string | undefined;
  /** Token disposition of the combatant's token (-2..1); undefined if unknown. */
  disposition(c: WorldCombatant): number | undefined;
  /** Core `Combatant#hasPlayerOwner`: a non-GM user OWNS the combatant's actor. */
  hasPlayerOwner(c: WorldCombatant): boolean;
  /** `Combatant#group?.name` (CombatantGroup embedded in the combat). */
  groupName(c: WorldCombatant): string | undefined;
  /** Display name: combatant name, else token name, else actor name. */
  displayName(c: WorldCombatant): string;
}

type Rec = Record<string, unknown>;
const OWNER = 3;
const ASSISTANT_GM = 3;

/**
 * OSE's `OSECombat.GROUPS` key order (colour groups for group initiative).
 * Read from the installed system's `dist/ose.js` (`actionGroups` /
 * `colors`), 2026-10-19.
 */
export const OSE_GROUP_ORDER = [
  'green',
  'red',
  'yellow',
  'purple',
  'blue',
  'orange',
  'white',
  'slow',
  'cast',
] as const;

/** Builds a {@link TurnOrderContext} from the cached world for one combat. */
export function turnOrderContext(
  world: WorldData | null | undefined,
  combat?: WorldCombat,
): TurnOrderContext | undefined {
  if (!world) {
    return undefined;
  }
  const systemId = String((world.system as Rec | undefined)?.id ?? '') || undefined;
  const nonGm = new Set(
    (world.users ?? []).filter((u) => (u.role ?? 0) < ASSISTANT_GM).map((u) => u._id),
  );
  const actors = new Map((world.actors ?? []).map((a) => [a._id, a as unknown as Rec]));
  const scenes = (world.scenes ?? []) as unknown as Rec[];
  const combatRec = (combat ?? {}) as unknown as Rec;
  const tokenOf = (c: WorldCombatant): Rec | undefined => {
    if (!c.tokenId) {
      return undefined;
    }
    const sceneId = c.sceneId ?? (combatRec.scene as string | undefined);
    const pool = sceneId ? scenes.filter((s) => s._id === sceneId) : scenes;
    for (const s of pool) {
      const t = ((s.tokens as Rec[] | undefined) ?? []).find((x) => x._id === c.tokenId);
      if (t) {
        return t;
      }
    }
    return undefined;
  };
  const ownedByPlayer = (ownership: unknown): boolean => {
    if (!ownership || typeof ownership !== 'object') {
      return false;
    }
    const o = ownership as Record<string, number>;
    if ((o.default ?? 0) >= OWNER && nonGm.size > 0) {
      return true;
    }
    return [...nonGm].some((id) => (o[id] ?? 0) >= OWNER);
  };
  const groups = new Map(
    ((combatRec.groups as Rec[] | undefined) ?? []).map((g) => [String(g._id), g]),
  );
  return {
    systemId,
    disposition(c) {
      const d = tokenOf(c)?.disposition;
      return typeof d === 'number' ? d : undefined;
    },
    hasPlayerOwner(c) {
      const actor = c.actorId ? actors.get(c.actorId) : undefined;
      if (ownedByPlayer(actor?.ownership)) {
        return true;
      }
      // Unlinked tokens may override ownership through their ActorDelta.
      const delta = tokenOf(c)?.delta as Rec | undefined;
      return ownedByPlayer(delta?.ownership);
    },
    groupName(c) {
      const gid = (c as unknown as Rec).group;
      const name = gid ? groups.get(String(gid))?.name : undefined;
      return typeof name === 'string' && name ? name : undefined;
    },
    displayName(c) {
      if (c.name) {
        return c.name;
      }
      const tn = tokenOf(c)?.name;
      if (typeof tn === 'string' && tn) {
        return tn;
      }
      const an = c.actorId ? actors.get(c.actorId)?.name : undefined;
      return typeof an === 'string' && an ? an : (c.actorId ?? c._id);
    },
  };
}

/** Core tie-break: document id, so the ordering is total and deterministic. */
function byId(a: WorldCombatant, b: WorldCombatant): number {
  if (a._id === b._id) {
    return 0;
  }
  return a._id > b._id ? 1 : -1;
}

/**
 * Mirrors OSE's `OSECombat#_sortCombatants` (system `ose`, dist/ose.js) for
 * combatants with EQUAL initiative:
 *  1. both in a (different) colour group -> `GROUPS` key order;
 *  2. token disposition descending (friendly 1 > neutral 0 > hostile -1);
 *  3. player-owned before not player-owned;
 *  4. both player-owned -> non-retainers first; both not -> retainers first.
 *     (OSE reads `combatant.system.retainer.enabled`, which core combatants
 *     never carry, so in practice this step is a no-op; mirrored verbatim.)
 *  5. same name -> id; else name `localeCompare`.
 */
function oseTieBreak(a: WorldCombatant, b: WorldCombatant, ctx: TurnOrderContext): number {
  const ga = ctx.groupName(a);
  const gb = ctx.groupName(b);
  if (ga && gb && ga !== gb) {
    const order = OSE_GROUP_ORDER as readonly string[];
    return order.indexOf(ga) - order.indexOf(gb);
  }
  const dispDiff = (ctx.disposition(b) ?? 0) - (ctx.disposition(a) ?? 0);
  if (dispDiff !== 0) {
    return dispDiff;
  }
  const pa = ctx.hasPlayerOwner(a);
  const pb = ctx.hasPlayerOwner(b);
  if (pa !== pb) {
    return pa ? -1 : 1;
  }
  const ra = Boolean(
    ((a as unknown as Rec).system as Rec | undefined)?.retainer &&
      (((a as unknown as Rec).system as Rec).retainer as Rec).enabled,
  );
  const rb = Boolean(
    ((b as unknown as Rec).system as Rec | undefined)?.retainer &&
      (((b as unknown as Rec).system as Rec).retainer as Rec).enabled,
  );
  if (ra !== rb) {
    if (pa && pb) {
      return ra ? 1 : -1;
    }
    if (!pa && !pb) {
      return ra ? -1 : 1;
    }
  }
  // Core's Combatant name falls back to token, then actor name.
  const na = ctx.displayName(a);
  const nb = ctx.displayName(b);
  if (na === nb) {
    return byId(a, b);
  }
  return na.localeCompare(nb);
}

/**
 * Compares two combatants by Foundry's turn-order rules.
 *
 * Initiative descending; combatants without a rolled initiative go last. Ties
 * use the game system's own tie-break when one is mirrored (OSE, see
 * {@link oseTieBreak}) and a context is supplied; otherwise core's document id.
 */
export function compareCombatants(
  a: WorldCombatant,
  b: WorldCombatant,
  ctx?: TurnOrderContext,
): number {
  const byInitiative = initiativeOf(b) - initiativeOf(a);
  if (byInitiative && !Number.isNaN(byInitiative)) {
    return byInitiative;
  }
  if (ctx?.systemId === 'ose') {
    return oseTieBreak(a, b, ctx);
  }
  return byId(a, b);
}

/**
 * Returns the combatants of `combat` in turn order.
 *
 * Sorts a **copy** — `combat` is a live reference into the world-data cache, so
 * sorting in place would silently reorder cached state as a side effect of a
 * read.
 */
export function getTurnOrder(combat: WorldCombat, ctx?: TurnOrderContext): WorldCombatant[] {
  return [...combat.combatants].sort((a, b) => compareCombatants(a, b, ctx));
}

/**
 * Whether the encounter is under way, derived the way core derives it.
 *
 * `Combat#started` is a **client-side getter** (`turns.length > 0 && round >
 * 0`), not schema data: `BaseCombat.defineSchema()` does not declare it, so a
 * Combat document read out of `worldData` never carries the key. Reading
 * `combat.started` therefore evaluates to `undefined` on every real world —
 * only hand-written fixtures have it — so started-ness is computed here from
 * the two fields the transport does deliver.
 */
export function isCombatStarted(combat: WorldCombat): boolean {
  return combat.round > 0 && combat.combatants.length > 0;
}

/**
 * Returns the combatant `combat.turn` currently points at, if any.
 *
 * Yields `undefined` when nobody is acting yet — the encounter has not been
 * started (initiatives are commonly assigned during round 0 setup), `turn` is
 * null, or the stored index no longer resolves to a combatant.
 */
export function getCurrentCombatant(
  combat: WorldCombat,
  ctx?: TurnOrderContext,
): WorldCombatant | undefined {
  if (!isCombatStarted(combat) || combat.turn === null || combat.turn === undefined) {
    return undefined;
  }
  return getTurnOrder(combat, ctx)[combat.turn];
}

/**
 * Computes where `actingCombatantId` lands in the turn order once `change` is
 * applied — i.e. the `turn` index that keeps the same combatant acting.
 *
 * The change is projected onto a copy rather than read back from the cache:
 * `setCombatantInitiative` resolves on the `modifyDocument` ack, while the
 * cache is updated by the separate broadcast, so the cached initiative may or
 * may not have caught up by the time this runs. Projecting is correct either
 * way (re-applying the same value is a no-op).
 *
 * @returns the new index, or `undefined` if the acting combatant is gone.
 */
export function turnIndexAfterInitiativeChange(
  combat: WorldCombat,
  change: { combatantId: string; initiative: number },
  actingCombatantId: string,
  ctx?: TurnOrderContext,
): number | undefined {
  const projected: WorldCombat = {
    ...combat,
    combatants: combat.combatants.map((c) =>
      c._id === change.combatantId ? { ...c, initiative: change.initiative } : c,
    ),
  };
  const index = getTurnOrder(projected, ctx).findIndex((c) => c._id === actingCombatantId);
  return index === -1 ? undefined : index;
}

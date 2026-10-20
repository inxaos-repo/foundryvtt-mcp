# GM Toolkit

Tools that let an assistant run a game session over the Foundry document
socket (`modifyDocument`) plus a fixed allow-list of socket events
(`pullToScene`, `resetFog`, `showEntry`, `shareImage`). There is deliberately
no tool that evaluates arbitrary JavaScript. Every write requires
`FOUNDRY_WRITE_ENABLED=true`.

Script macros are a second, separate opt-in. Foundry runs a script macro's
JavaScript in the client of whoever executes it, so with
`FOUNDRY_ALLOW_SCRIPT_MACROS` unset or `false` (the default) `gm_document`
refuses to create a `Macro` of type `script`, to change a macro's type to
`script`, or to change the `command` or `type` of an existing script macro (an
unknown macro id is refused too). Chat macros and deleting macros are always
allowed. Set `FOUNDRY_ALLOW_SCRIPT_MACROS=true` only if you trust the
assistant to write code that your players' browsers will run.

| Area | Tools |
|---|---|
| Documents | `gm_document` |
| Scenes | `duplicate_scene`, `activate_scene`, `view_scene`, `get_scene_full`, `set_scene_darkness` |
| Tokens | `create_token`, `set_token_hidden`, `set_token_vision`, `delete_token`, `move_token_checked` |
| Lookups (read-only) | `tokens_near`, `token_for_actor`, `turn_context` |
| Doors, fog, lights, notes | `list_doors`, `set_door_state`, `reset_fog`, `get_fog_state`, `set_light_state`, `get_note_page` |
| Chat and dice | `post_chat`, `read_chat`, `gm_roll`, `system_roll`, `roll_table` |
| Combat | `start_encounter`, `roll_initiative`, `combat_control`, `get_turn_order` |
| Actors | `apply_damage`, `set_condition`, `adjust_item_quantity` |
| Presentation | `share_journal`, `control_audio` |
| Party and content | `list_party`, `import_from_compendium`, `lookup_rule` |

## Foundry behaviour worth knowing

- The server acknowledges a `modifyDocument` request to the requesting socket
  but broadcasts the change only to *other* sockets. The client therefore
  applies its own write results to the cached world.
- For embedded documents, `get` ignores `query` and returns the whole
  collection; `gm_document` filters locally.
- Scene darkness and global light moved under `environment` in v12.
- Since v13 a token position change is a *movement*: browser clients send all
  position fields with `diff: false` and an `_movement` record in the
  operation. Connected clients ignore an x/y update without it (the change is
  stored and shows only after a reload), so the bridge builds the same record
  for every token position update, including `gm_document` Token updates.
- `gm_document` update accepts `data` or `updates` (an object or an array, each
  with `_id`), or a single object plus `id`.
- `pullToScene` and `resetFog` have no acknowledgement; `showEntry` does.
  `activate_scene` and `view_scene` instead wait for each online target's
  client to report the scene through `userActivity` (re-pulling once), and
  `reset_fog` reads the scene's FogExploration records back to confirm the
  old ones are gone.

## System roll adapters

`system_roll` delegates to an adapter chosen by the world's system id. A
headless client cannot call a system's own roll methods (they exist only on
client-side document classes), so adapters derive rolls from actor data.

```ts
import { registerSystemAdapter } from './src/tools/gm/systems/registry.js';

registerSystemAdapter({
  systemId: 'my-system',
  initiativeFormula: '1d20',
  kinds: { save: 'key: fortitude|reflex|will' },
  buildCheck(actor, kind, { key, modifier = 0 }) {
    const bonus = Number((actor.system as any)?.saves?.[key ?? '']?.value ?? 0);
    return {
      formula: `1d20 + ${bonus + modifier}`,
      label: `${key} save`,
      evaluate: (total) => (total >= 15 ? 'SUCCESS' : 'FAILURE'),
    };
  },
});
```

Adapters for Old-School Essentials (`ose`) and Pathfinder Second Edition
(`pf2e`) are included.

### PF2e

- Kinds: `save` (key `fortitude`/`reflex`/`will`, or `fort`/`ref`),
  `skill` (a skill slug such as `stealth`, a 3-letter alias such as `ste`,
  or a lore name such as `warfare`), and `perception`. `target` is the DC;
  the verdict is the degree of success (critical success, success, failure,
  critical failure), with a natural 20 or 1 moving it one step.
- NPC checks use the saves, perception, skills and lore modifiers stored on
  the NPC, so they match the sheet. Untrained NPC skills use the attribute
  modifier.
- Character checks are rebuilt from source data: attribute modifiers from
  ancestry, background, class and level boosts (partial boosts above +4),
  plus proficiency (2 × rank + level when trained) from the class, background
  and skill ranks. Item, status and circumstance bonuses, feats and rule
  elements are not applied, so pass `modifier` for those. Check the sheet when
  it matters.
- `set_condition` adds PF2e conditions as condition items copied from the
  `pf2e.conditionitems` compendium (not ActiveEffects). Valued conditions
  (clumsy, doomed, drained, dying, enfeebled, frightened, sickened, slowed,
  stunned, stupefied, wounded, cursebound) take `value`; an existing
  condition's value is updated in place, and `value: 0` or `active: false`
  removes it.
- Initiative in encounters still defaults to `1d20` (no Perception bonus).

## Lookups

- `tokens_near` lists tokens within `radius` grid squares of a token or a
  pixel point, nearest first. Distances are edge to edge (adjacent = 1
  square, diagonals cost 1) and are also given in scene units. Filters:
  `disposition`, `includeHidden` (default true; hidden tokens are flagged).
- `token_for_actor` finds the tokens for an actor id or exact name, linked or
  unlinked, in one scene or all scenes (active scene first).
- `turn_context` reports the active combat's current combatant (round, turn,
  HP, conditions) and the tokens around it with distance, disposition, HP,
  conditions and line of sight. `map=true` adds an ASCII map (`mapRadius`
  squares each way, default 5): `@` is the combatant, letters are tokens (see
  the legend), and the character between two cells is the wall on that edge:
  `#` wall, `+` closed door, `L` locked door; open doors are blank.
- HP is read from `system.hp` or `system.attributes.hp` (an unlinked token's
  delta wins). Conditions are the status ids on enabled effects.
- Line of sight is a single centre-to-centre test against sight-blocking
  walls: open doors and walls with no sight restriction do not block, limited
  walls block when two are crossed. It ignores lighting, darkness, token
  senses and one-way walls, so it can disagree with what a player sees.

## Roll tables

`roll_table` draws from a world RollTable by id or name (exact, then unique
partial match). It rolls the table formula (or `1d<highest range>` when the
formula is empty), picks the results whose range covers the total, and posts
a draw card flagged `core.RollTable` with the roll attached unless the table
hides its roll. Tables without replacement mark drawn results and skip them
(rerolling, as Foundry does); `reset=true` clears the drawn flags first and
`times` draws up to 10 results. Roll modes behave like Foundry's: in `gm` and
`blind` mode other players still see that a private roll happened, but not
the result. Compendium tables are not supported; import the table first.

## Limitations

- `move_token_checked` searches a square-by-square route (8 directions, no
  corner cutting) between token centres that avoids movement-blocking walls
  and closed or locked doors, and moves the token along it. It treats the
  token as a point (its centre), which is also how Foundry tests token
  movement against walls, so large tokens are routed by their centre and may
  squeeze through gaps narrower than their footprint. One-way walls block
  only from their closed side, as in Foundry. Regions, difficult terrain and
  movement cost are not modelled, and diagonals count as one square. With `openDoors=true` it may route through closed, unlocked
  doors (only when no door-free route exists) and opens them first; locked
  and secret doors need `forceDoors=true`. Route corners are sent as
  explicit waypoints so players' clients animate the walk along the route.
- `get_scene_full` warns about player tokens still on the default white
  mystery-man icon, which is hard to see on light maps.
- `set_condition` on an unlinked token writes to that token's ActorDelta (its
  own copy of the actor). A status inherited from the base actor cannot be
  removed per token; remove it from the actor instead.

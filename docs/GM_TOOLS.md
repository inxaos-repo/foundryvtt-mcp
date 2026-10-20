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
| Doors, fog, lights, notes | `list_doors`, `set_door_state`, `reset_fog`, `get_fog_state`, `set_light_state`, `get_note_page` |
| Chat and dice | `post_chat`, `read_chat`, `gm_roll`, `system_roll` |
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

An adapter for Old-School Essentials (`ose`) is included.

## Limitations

- `move_token_checked` searches a square-by-square route (8 directions, no
  corner cutting) between token centres that avoids movement-blocking walls
  and closed or locked doors, and moves the token along it. It treats the
  token as a point and does not model one-way walls, regions, terrain or
  line of sight.
- `get_scene_full` warns about player tokens still on the default white
  mystery-man icon, which is hard to see on light maps.
- `set_condition` on an unlinked token writes to that token's ActorDelta (its
  own copy of the actor). A status inherited from the base actor cannot be
  removed per token; remove it from the actor instead.

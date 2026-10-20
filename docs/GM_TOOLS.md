# GM Toolkit

Tools that let an assistant run a game session over the Foundry document
socket (`modifyDocument`) plus a fixed allow-list of socket events
(`pullToScene`, `resetFog`, `showEntry`, `shareImage`). There is deliberately
no tool that evaluates arbitrary JavaScript. Every write requires
`FOUNDRY_WRITE_ENABLED=true`.

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
- `pullToScene` and `resetFog` have no acknowledgement; `showEntry` does.

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

- `move_token_checked` tests the straight path between token centres against
  movement-blocking walls and closed doors. It does not model one-way walls,
  regions or line of sight.
- `set_condition` on an unlinked token writes to that token's ActorDelta (its
  own copy of the actor). A status inherited from the base actor cannot be
  removed per token; remove it from the actor instead.

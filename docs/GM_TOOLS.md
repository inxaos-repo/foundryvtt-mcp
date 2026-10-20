# GM toolkit (AI Gamemaster tools)

Tools that let an AI GM run a whole adventure over the Foundry document socket
(`modifyDocument`) plus a fixed allow-list of socket events (`pullToScene`,
`resetFog`, `showEntry`, `shareImage`). There is deliberately **no** arbitrary
JavaScript evaluation tool. Every write needs `FOUNDRY_WRITE_ENABLED=true`.

| Area | Tools |
|---|---|
| Generic | `gm_document` (get/create/update/delete any document or embedded document) |
| Scenes | `duplicate_scene`, `activate_scene`, `view_scene`, `get_scene_full`, `set_scene_darkness` |
| Tokens | `create_token`, `set_token_hidden`, `set_token_vision`, `delete_token`, `move_token_checked` |
| Doors / fog / lights | `list_doors`, `set_door_state`, `reset_fog`, `get_fog_state`, `set_light_state` |
| Chat & dice | `post_chat`, `read_chat`, `gm_roll`, `system_roll` (OSE saves/checks/attacks/morale) |
| Combat | `start_encounter`, `roll_initiative`, `combat_control`, `get_turn_order` |
| Actors | `apply_damage`, `set_condition`, `adjust_item_quantity` |
| Journals | `share_journal`, `get_note_page`, `lookup_rule` |
| Audio / users / compendium | `control_audio`, `list_party`, `import_from_compendium` |

Limits: `move_token_checked` is a straight-line wall/door collision test, not
line of sight; `system_roll` computes OSE rolls from the actor sheet (the OSE
client API is not reachable from a headless socket); `set_condition` works on
actors and linked tokens only.

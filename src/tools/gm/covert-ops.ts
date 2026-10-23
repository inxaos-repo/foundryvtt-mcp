/**
 * covert-ops-d20 helpers: derived actor summary and spending action dice
 * outside a roll (healing, activating threats, GM-adjudicated uses).
 */

import { evaluateDiceFormula } from '../../foundry/dice-formula.js';
import { covertActor } from './covert-bridge.js';
import { GmToolError, num, type Obj, ok, resolveTarget, str, world } from './helpers.js';
import { COVERT_OPS_ID, covertOpsSummary } from './systems/covert-ops.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

export const covertOpsTools: GmToolSpec[] = [
  {
    name: 'covert_ops',
    description:
      'covert-ops-d20 actor helper. action="summary": abilities/mods, skill totals with threat/error, saves, Defense, initiative, attack bonuses, vitality, wounds, action dice (derived values recomputed from actor data). action="spend_action_die": spend count dice (default 1) from the pool and roll them; result is returned and posted to chat. For rolls use system_roll (actionDice adds dice to a check); for damage use apply_damage (toWounds for crits).' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['summary', 'spend_action_die'] },
        actorId: { type: 'string', description: 'Actor id or name' },
        tokenId: { type: 'string', description: 'Or a token (uses its actor)' },
        sceneId: { type: 'string' },
        count: { type: 'number', description: 'Action dice to spend (default 1)' },
        reason: { type: 'string', description: 'Shown in chat, e.g. "activate threat"' },
      },
      required: ['action'],
    },
    async run(client, args) {
      const systemId = String((world(client).system as Obj | undefined)?.id ?? '');
      if (systemId !== COVERT_OPS_ID) {
        throw new GmToolError(
          `covert_ops needs the ${COVERT_OPS_ID} system (world is "${systemId}")`,
        );
      }
      const action = str(args, 'action') as string;
      const t = resolveTarget(client, args);
      const actor = await covertActor(client, t);
      const s = covertOpsSummary(actor as Obj) as Obj & {
        actionDice: { value: number; die: number };
      };
      const name = t.token?.name ?? t.actor.name;
      if (action === 'summary') {
        return ok(
          `🕵️ ${name}: Def ${s.defense}, VP ${(s.vitality as Obj).value}/${(s.vitality as Obj).max}, WP ${(s.wounds as Obj).value}/${(s.wounds as Obj).max}, AD ${s.actionDice.value}d${s.actionDice.die}`,
          s,
        );
      }
      if (action === 'spend_action_die') {
        const count = num(args, 'count', false) ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > s.actionDice.value) {
          throw new GmToolError(
            `${name} has ${s.actionDice.value} action dice; cannot spend ${count}`,
          );
        }
        const formula = `${count}d${s.actionDice.die}`;
        const r = evaluateDiceFormula(formula);
        const left = s.actionDice.value - count;
        await client.gmModify('Actor', 'update', {
          updates: [{ _id: t.actor._id, 'system.actionDice.value': left }],
          diff: true,
        });
        const reason = str(args, 'reason', false);
        await client.gmModify('ChatMessage', 'create', {
          data: [
            {
              author: world(client).userId,
              speaker: { actor: t.actor._id, alias: name },
              flavor: `Action ${count === 1 ? 'die' : 'dice'}${reason ? `: ${reason}` : ''}`,
              content: `<p>${formula} → <strong>${r.total}</strong> (${left} left)</p>`,
            },
          ],
        });
        return ok(`🎲 ${name} spends ${formula} → ${r.total} (${left} left)`, {
          total: r.total,
          actionDiceLeft: left,
        });
      }
      throw new GmToolError('action must be summary or spend_action_die');
    },
  },
];

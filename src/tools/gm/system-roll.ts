/**
 * `system_roll`: rules-aware rolls through a per-system adapter.
 */

import { evaluateDiceFormula } from '../../foundry/dice-formula.js';
import { type RollMode, rollModeProp, speakerFor, toFoundryRoll } from './chat.js';
import { GmToolError, gmUserIds, num, type Obj, ok, resolveTarget, str, world } from './helpers.js';
import { getSystemAdapter, listSystemAdapters } from './systems/registry.js';
import type { SystemCheckOptions } from './systems/types.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

export const systemRollTools: GmToolSpec[] = [
  {
    name: 'system_roll',
    description:
      'Rules-aware roll for an actor using the world\'s game-system adapter (save, ability check, attack, morale…), posted to chat with a success/failure verdict. Kinds depend on the system; call with kind="help" to list them. Computed from actor data because system roll APIs are client-side only.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        actorId: { type: 'string', description: 'Actor id or name' },
        tokenId: { type: 'string', description: 'Or a token (uses its actor)' },
        kind: {
          type: 'string',
          description: 'Check kind, e.g. save, ability, attack; "help" lists them',
        },
        key: { type: 'string', description: 'Sub-type, e.g. save category or ability' },
        target: {
          type: 'number',
          description: 'Number to beat when not on the sheet, e.g. target AC',
        },
        variant: { type: 'string', description: 'Adapter variant, e.g. melee or missile' },
        modifier: { type: 'number' },
        ...rollModeProp,
      },
      required: ['kind'],
    },
    async run(client, args) {
      const systemId = String((world(client).system as Obj | undefined)?.id ?? '');
      const adapter = getSystemAdapter(systemId);
      if (!adapter) {
        const known = listSystemAdapters()
          .map((a) => a.systemId)
          .join(', ');
        throw new GmToolError(
          `No roll adapter for system "${systemId}" (available: ${known}); use gm_roll`,
        );
      }
      const kind = str(args, 'kind') as string;
      if (kind === 'help' || !(kind in adapter.kinds)) {
        const kinds = Object.entries(adapter.kinds)
          .map(([k, v]) => `${k} (${v})`)
          .join('; ');
        if (kind === 'help') {
          return ok(`🎲 ${adapter.systemId} kinds: ${kinds}`);
        }
        throw new GmToolError(`Unknown kind "${kind}" for ${adapter.systemId}: ${kinds}`);
      }
      const { actor, token } = resolveTarget(client, args);
      const opts: SystemCheckOptions = {};
      const key = str(args, 'key', false);
      const tgt = num(args, 'target', false);
      const variant = str(args, 'variant', false);
      const modifier = num(args, 'modifier', false);
      if (key) {
        opts.key = key;
      }
      if (tgt !== undefined) {
        opts.target = tgt;
      }
      if (variant) {
        opts.variant = variant;
      }
      if (modifier !== undefined) {
        opts.modifier = modifier;
      }
      let chk: ReturnType<typeof adapter.buildCheck>;
      try {
        chk = adapter.buildCheck(actor, kind, opts);
      } catch (err) {
        throw new GmToolError(err instanceof Error ? err.message : String(err));
      }
      const pre = evaluateDiceFormula(chk.formula);
      const natural = pre.terms.find((t) => t.kind === 'dice')?.rolls?.[0] ?? 0;
      const verdict = chk.evaluate(pre.total, natural);
      const name = token?.name ?? actor.name;
      const speaker = token
        ? speakerFor(client, { tokenId: token._id })
        : { actor: actor._id, alias: actor.name };
      // Post the already-evaluated roll so the chat card and the verdict agree.
      const w = world(client);
      const mode = (str(args, 'mode', false) ?? 'public') as RollMode;
      const msg: Obj = {
        author: w.userId,
        speaker,
        flavor: `${chk.label}`,
        content: `<p><strong>${pre.total}</strong> — ${verdict}</p>`,
        rolls: [JSON.stringify(toFoundryRoll(chk.formula, pre))],
        sound: 'sounds/dice.wav',
      };
      if (mode !== 'public') {
        msg.whisper = mode === 'self' ? [w.userId] : gmUserIds(client);
      }
      if (mode === 'blind') {
        msg.blind = true;
      }
      await client.gmModify('ChatMessage', 'create', { data: [msg] });
      return ok(`🎲 ${name}: ${chk.label} → ${pre.total} (${pre.breakdown}) — ${verdict}`, {
        total: pre.total,
        natural,
        verdict,
      });
    },
  },
];

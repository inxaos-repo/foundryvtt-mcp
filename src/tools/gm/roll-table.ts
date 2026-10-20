/**
 * roll_table: draw from a world RollTable the way Foundry's RollTable#draw
 * does, post the result card to chat in the requested roll mode, and return
 * the drawn result(s).
 */

import type { FoundryClient } from '../../foundry/client.js';
import { type DiceFormulaResult, evaluateDiceFormula } from '../../foundry/dice-formula.js';
import { type RollMode, rollModeProp, speakerFor, toFoundryRoll } from './chat.js';
import {
  bool,
  GmToolError,
  gmUserIds,
  num,
  type Obj,
  ok,
  str,
  stripHtml,
  world,
} from './helpers.js';
import { type GmToolSpec, WRITE_NOTE } from './tool-spec.js';

type TableResult = Obj & { _id: string; range?: [number, number]; drawn?: boolean };
type RollTable = Obj & { _id: string; name?: string; results?: TableResult[] };

const MAX_REROLLS = 100;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function findTable(client: FoundryClient, key: string): RollTable {
  const tables = (world(client).tables ?? []) as RollTable[];
  const byId = tables.find((t) => t._id === key);
  if (byId) {
    return byId;
  }
  const lower = key.toLowerCase();
  const exact = tables.filter((t) => String(t.name ?? '').toLowerCase() === lower);
  if (exact.length === 1) {
    return exact[0] as RollTable;
  }
  if (exact.length > 1) {
    throw new GmToolError(
      `Several tables are named "${key}": ${exact.map((t) => t._id).join(', ')}. Pass the id.`,
    );
  }
  const partial = tables.filter((t) =>
    String(t.name ?? '')
      .toLowerCase()
      .includes(lower),
  );
  if (partial.length === 1) {
    return partial[0] as RollTable;
  }
  throw new GmToolError(
    partial.length
      ? `"${key}" matches several tables: ${partial.map((t) => `${t.name} [${t._id}]`).join(', ')}`
      : `No RollTable "${key}"`,
  );
}

/** Default formula: 1d(highest range end), like Foundry's normalised tables. */
export function tableFormula(table: RollTable): string {
  const f = String(table.formula ?? '').trim();
  if (f) {
    return f;
  }
  const max = Math.max(0, ...(table.results ?? []).map((r) => Number(r.range?.[1] ?? 0)));
  if (max < 1) {
    throw new GmToolError(`Table ${table.name} has no formula and no result ranges`);
  }
  return `1d${max}`;
}

/** Text a result shows: v13+ name/description, older text, plus a document link. */
export function resultLabel(r: TableResult): string {
  const name = String(r.name ?? '').trim();
  const text = String(r.text ?? '').trim();
  const desc = stripHtml(String(r.description ?? '')).trim();
  const main = name || text || desc || '(blank result)';
  return desc && desc !== main && (name || text) ? `${main} — ${desc}` : main;
}

function resultLink(r: TableResult): string | undefined {
  if (typeof r.documentUuid === 'string' && r.documentUuid) {
    return r.documentUuid;
  }
  if (r.documentCollection && r.documentId) {
    const coll = String(r.documentCollection);
    // Pack results store the pack id ("scope.name") as the collection.
    return coll.includes('.')
      ? `Compendium.${coll}.${String(r.documentId)}`
      : `${coll}.${String(r.documentId)}`;
  }
  return undefined;
}

export interface Draw {
  roll: DiceFormulaResult;
  results: TableResult[];
}

/**
 * Roll the table formula and pick the results whose range covers the total.
 * Without replacement, drawn results are skipped and the roll is repeated
 * until an undrawn result comes up, as Foundry does.
 */
export function drawFrom(table: RollTable, rng: () => number = Math.random): Draw {
  const formula = tableFormula(table);
  const replacement = table.replacement !== false;
  const pool = (table.results ?? []).filter((r) => replacement || !r.drawn);
  if (!pool.length) {
    throw new GmToolError(
      `Every result of ${table.name} has been drawn. Pass reset=true to reset the table first.`,
    );
  }
  for (let i = 0; i < MAX_REROLLS; i++) {
    const roll = evaluateDiceFormula(formula, rng);
    const results = pool.filter((r) => {
      const [lo, hi] = (r.range ?? [0, -1]) as [number, number];
      return roll.total >= lo && roll.total <= hi;
    });
    if (results.length) {
      return { roll, results };
    }
  }
  throw new GmToolError(
    `No result of ${table.name} matched ${MAX_REROLLS} rolls of ${formula}; check the ranges.`,
  );
}

function card(table: RollTable, results: TableResult[]): string {
  const items = results
    .map((r) => {
      const link = resultLink(r);
      const label = escapeHtml(resultLabel(r));
      const body = link ? `@UUID[${link}]{${label}}` : label;
      const img = typeof r.img === 'string' && r.img ? `<img src="${escapeHtml(r.img)}">` : '';
      return `<li class="table-result">${img}<div class="result-text">${body}</div></li>`;
    })
    .join('');
  return `<div class="table-draw"><ol class="table-results">${items}</ol></div>`;
}

export const rollTableTools: GmToolSpec[] = [
  {
    name: 'roll_table',
    description:
      'Draw from a world RollTable (by id or name) and post the result to chat in the chosen roll mode (public, gm, blind, self). Follows the table formula and ranges; tables without replacement mark the result drawn and skip drawn results. Returns the roll and the drawn result text/links.' +
      WRITE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'RollTable id or name' },
        ...rollModeProp,
        reset: {
          type: 'boolean',
          description: 'Reset every drawn result first (tables without replacement)',
        },
        times: { type: 'number', description: 'Number of draws (default 1, max 10)' },
        flavor: { type: 'string', description: 'Override the chat flavour text' },
      },
      required: ['table'],
    },
    async run(client, args) {
      const table = findTable(client, str(args, 'table') as string);
      const mode = (str(args, 'mode', false) ?? 'public') as RollMode;
      const times = Math.min(10, Math.max(1, Math.floor(num(args, 'times', false) ?? 1)));
      const parentUuid = `RollTable.${table._id}`;
      // Work on a local copy so repeated draws see results drawn earlier.
      const results = (table.results ?? []).map((r) => ({ ...r }));
      if (bool(args, 'reset', false)) {
        const drawn = results.filter((r) => r.drawn);
        if (drawn.length) {
          await client.gmModify('TableResult', 'update', {
            parentUuid,
            updates: drawn.map((r) => ({ _id: r._id, drawn: false })),
          });
        }
        for (const r of results) {
          r.drawn = false;
        }
      }
      const w = world(client);
      const draws: Array<{ total: number; breakdown: string; results: Obj[]; messageId: unknown }> =
        [];
      for (let n = 0; n < times; n++) {
        const { roll, results: picked } = drawFrom({ ...table, results });
        if (table.replacement === false) {
          await client.gmModify('TableResult', 'update', {
            parentUuid,
            updates: picked.map((r) => ({ _id: r._id, drawn: true })),
          });
          for (const r of picked) {
            r.drawn = true;
          }
        }
        const msg: Obj = {
          author: w.userId,
          speaker: speakerFor(client, {}),
          flavor:
            str(args, 'flavor', false) ??
            `Draws ${picked.length} result${picked.length === 1 ? '' : 's'} from the ${escapeHtml(String(table.name ?? 'table'))} table.`,
          content: card(table, picked),
          flags: { core: { RollTable: table._id } },
          sound: 'sounds/dice.wav',
        };
        if (table.displayRoll !== false) {
          msg.rolls = [JSON.stringify(toFoundryRoll(tableFormula(table), roll))];
        }
        if (mode === 'gm' || mode === 'blind') {
          msg.whisper = gmUserIds(client);
        }
        if (mode === 'blind') {
          msg.blind = true;
        }
        if (mode === 'self') {
          msg.whisper = [w.userId];
        }
        const res = (await client.gmModify('ChatMessage', 'create', { data: [msg] })) as Obj[];
        draws.push({
          total: roll.total,
          breakdown: roll.breakdown,
          messageId: res[0]?._id,
          results: picked.map((r) => {
            const link = resultLink(r);
            return { _id: r._id, text: resultLabel(r), ...(link ? { uuid: link } : {}) };
          }),
        });
      }
      const lines = draws.map(
        (d) => `🎲 ${d.total} → ${d.results.map((r) => String(r.text)).join('; ')}`,
      );
      return ok(`📜 ${table.name} [${mode}]\n${lines.join('\n')}`, {
        tableId: table._id,
        draws,
      });
    },
  },
];

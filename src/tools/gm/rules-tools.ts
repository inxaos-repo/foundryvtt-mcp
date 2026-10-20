/**
 * GM toolkit — rule lookup over world journals and compendium packs.
 */

import { embedded, num, type Obj, ok, str, stripHtml, strList, world } from './helpers.js';
import type { GmToolSpec } from './spec.js';

export const rulesTools: GmToolSpec[] = [
  {
    name: 'lookup_rule',
    description:
      'Search rules text: world journal pages and JournalEntry compendium packs (e.g. the OSE rules) by name and content. Returns matching pages with excerpts.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        packs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit compendium search to these packs',
        },
        maxResults: { type: 'number', description: 'Default 5' },
      },
      required: ['query'],
    },
    async run(client, args) {
      const q = (str(args, 'query') as string).toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const max = num(args, 'maxResults', false) ?? 5;
      const w = world(client);
      const hits: Array<{
        score: number;
        source: string;
        entry: string;
        page: string;
        excerpt: string;
      }> = [];
      const scorePages = (source: string, entries: Obj[]): void => {
        for (const j of entries) {
          for (const p of embedded(j, 'pages')) {
            const text = stripHtml((p.text as Obj)?.content ?? '', 100000);
            const hay = `${j.name} ${p.name} ${text}`.toLowerCase();
            const title = `${j.name} ${p.name}`.toLowerCase();
            let score = 0;
            for (const word of words) {
              if (title.includes(word)) {
                score += 5;
              }
              if (hay.includes(word)) {
                score += 1;
              }
            }
            if (score > 0 && words.every((word) => hay.includes(word))) {
              const at = Math.max(0, text.toLowerCase().indexOf(words[0] ?? ''));
              hits.push({
                score,
                source,
                entry: String(j.name),
                page: String(p.name),
                excerpt: text.slice(Math.max(0, at - 200), at + 600),
              });
            }
          }
        }
      };
      scorePages('world', w.journal as unknown as Obj[]);
      const wanted = strList(args, 'packs');
      const packs = (((w as unknown as Obj).packs as Obj[]) ?? []).filter(
        (p) =>
          (p.type ?? p.documentName) === 'JournalEntry' &&
          (!wanted.length || wanted.includes(String(p.id))),
      );
      for (const p of packs.slice(0, 10)) {
        try {
          scorePages(String(p.id), (await client.gmGet('JournalEntry', { pack: p.id })) as Obj[]);
        } catch {
          // pack unreadable for this user — skip
        }
      }
      hits.sort((a, b) => b.score - a.score);
      const top = hits.slice(0, max);
      if (!top.length) {
        return ok(
          `📚 No rules text matched "${q}" (searched world journals and ${packs.length} pack(s))`,
        );
      }
      return ok(
        `📚 ${top.length} match(es) for "${q}":\n\n${top.map((h) => `### ${h.entry} › ${h.page} [${h.source}]\n${h.excerpt}`).join('\n\n')}`,
      );
    },
  },
];

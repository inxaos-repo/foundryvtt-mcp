import { describe, expect, it } from 'vitest';
import { getAllTools } from '../../definitions.js';
import { toolRegistry } from '../../registry.js';
import { gmToolSpecs } from '../index.js';
import { ID, makeClient, run } from './fixtures.js';

describe('gm toolkit wiring', () => {
  it('registers every gm tool and lists it', () => {
    const listed = new Set(getAllTools().map((t) => t.name));
    for (const spec of gmToolSpecs) {
      expect(toolRegistry.has(spec.name)).toBe(true);
      expect(listed.has(spec.name)).toBe(true);
    }
  });

  it('has no duplicate tool names and no stubs', () => {
    const names = getAllTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain('diagnose_errors');
    expect(names.filter((n) => n === 'lookup_rule')).toHaveLength(1);
  });

  it('every write tool mentions the write guard', () => {
    const readOnly = new Set([
      'get_scene_full',
      'list_doors',
      'get_fog_state',
      'get_note_page',
      'read_chat',
      'get_turn_order',
      'list_party',
      'lookup_rule',
      'gm_document',
    ]);
    for (const s of gmToolSpecs.filter((x) => !readOnly.has(x.name))) {
      expect(s.description).toContain('FOUNDRY_WRITE_ENABLED');
    }
  });

  it('surfaces the write-guard error from the client', async () => {
    const { client, gmModify } = makeClient();
    gmModify.mockRejectedValueOnce(
      new Error('Write operations are disabled (FOUNDRY_WRITE_ENABLED)'),
    );
    const { res, text } = await run('gm_document', client, {
      action: 'update',
      documentType: 'Actor',
      data: { _id: ID(1), name: 'X' },
    });
    expect(res.isError).toBe(true);
    expect(text).toContain('FOUNDRY_WRITE_ENABLED');
  });
});

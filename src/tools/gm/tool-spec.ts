/**
 * Declarative tool spec shared by the GM toolkit. Each spec is adapted into
 * the registry's `Tool` interface; thrown errors become `isError` results so a
 * bad argument never surfaces as a JSON-RPC failure.
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { Tool, ToolContext, ToolResult } from '../base.js';
import type { Obj } from './helpers.js';

/** Suffix for every tool that writes; the client enforces the flag. */
export const WRITE_NOTE = ' Requires FOUNDRY_WRITE_ENABLED=true.';

export interface GmToolSpec {
  name: string;
  description: string;
  inputSchema: Obj;
  run: (client: FoundryClient, args: Obj) => Promise<ToolResult>;
}

export function toTool(spec: GmToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    async execute(args: unknown, ctx: ToolContext): Promise<ToolResult> {
      try {
        return await spec.run(ctx.foundryClient, (args ?? {}) as Obj);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: `❌ ${spec.name}: ${message}` }], isError: true };
      }
    },
  };
}

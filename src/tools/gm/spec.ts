/**
 * GM toolkit — tool spec and adapter to the server Tool interface.
 */

import type { FoundryClient } from '../../foundry/client.js';
import type { Tool, ToolContext, ToolResult } from '../base.js';
import type { Obj } from './helpers.js';

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

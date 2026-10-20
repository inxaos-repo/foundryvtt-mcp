/**
 * GM toolkit: tools for running a game session over the Foundry document
 * socket. There is deliberately no code-evaluation tool; everything goes
 * through `modifyDocument` or a fixed allow-list of socket events.
 */
import type { Tool } from '../base.js';
import { documentTools } from './document.js';
import { mediaTools } from './media.js';
import { type GmToolSpec, toTool } from './tool-spec.js';

export const gmToolSpecs: GmToolSpec[] = [...documentTools, ...mediaTools];

export const gmTools: Tool[] = gmToolSpecs.map(toTool);

export const gmToolDefinitions = gmToolSpecs.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

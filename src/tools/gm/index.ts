/**
 * GM toolkit: everything an AI Gamemaster needs to run an adventure over the
 * Foundry document socket. No arbitrary code evaluation — documents and a
 * fixed allow-list of socket events only.
 */
import type { Tool } from '../base.js';
import { playTools } from './play-tools.js';
import { sceneTools, toTool } from './scene-tools.js';

export const gmToolSpecs = [...sceneTools, ...playTools];
export const gmTools: Tool[] = gmToolSpecs.map(toTool);
export const gmToolDefinitions = gmToolSpecs.map((s) => ({
  name: s.name,
  description: s.description,
  inputSchema: s.inputSchema,
}));

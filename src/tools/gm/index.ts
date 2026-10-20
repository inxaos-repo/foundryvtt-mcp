/**
 * GM toolkit: everything an AI Gamemaster needs to run an adventure over the
 * Foundry document socket. No arbitrary code evaluation — documents and a
 * fixed allow-list of socket events only.
 */
import type { Tool } from '../base.js';
import { actorTools } from './actor-tools.js';
import { chatTools } from './chat-tools.js';
import { combatTools } from './combat-tools.js';
import { rulesTools } from './rules-tools.js';
import { sceneTools } from './scene-tools.js';
import { toTool } from './spec.js';

export const gmToolSpecs = [
  ...sceneTools,
  ...chatTools,
  ...combatTools,
  ...actorTools,
  ...rulesTools,
];
export const gmTools: Tool[] = gmToolSpecs.map(toTool);
export const gmToolDefinitions = gmToolSpecs.map((s) => ({
  name: s.name,
  description: s.description,
  inputSchema: s.inputSchema,
}));

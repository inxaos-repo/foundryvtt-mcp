/**
 * GM toolkit: tools for running a game session over the Foundry document
 * socket. There is deliberately no code-evaluation tool; everything goes
 * through `modifyDocument` or a fixed allow-list of socket events.
 */
import type { Tool } from '../base.js';
import { actorTools } from './actor.js';
import { chatTools } from './chat.js';
import { combatTools } from './combat.js';
import { compendiumTools } from './compendium.js';
import { documentTools } from './document.js';
import { lookupTools } from './lookup.js';
import { mediaTools } from './media.js';
import { partyTools } from './party.js';
import { rulesTools } from './rules.js';
import { sceneTools } from './scene.js';
import { systemRollTools } from './system-roll.js';
import { type GmToolSpec, toTool } from './tool-spec.js';

export const gmToolSpecs: GmToolSpec[] = [
  ...documentTools,
  ...sceneTools,
  ...lookupTools,
  ...chatTools,
  ...systemRollTools,
  ...combatTools,
  ...actorTools,
  ...mediaTools,
  ...partyTools,
  ...compendiumTools,
  ...rulesTools,
];

export const gmTools: Tool[] = gmToolSpecs.map(toTool);

export const gmToolDefinitions = gmToolSpecs.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

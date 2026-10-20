import { ose } from './ose.js';
import { pf2eAdapter } from './pf2e.js';
import type { SystemRollAdapter } from './types.js';

const adapters = new Map<string, SystemRollAdapter>();

export function registerSystemAdapter(adapter: SystemRollAdapter): void {
  adapters.set(adapter.systemId, adapter);
}

export function getSystemAdapter(systemId: string | undefined): SystemRollAdapter | undefined {
  return systemId ? adapters.get(systemId) : undefined;
}

export function listSystemAdapters(): SystemRollAdapter[] {
  return [...adapters.values()];
}

registerSystemAdapter(ose);
registerSystemAdapter(pf2eAdapter);

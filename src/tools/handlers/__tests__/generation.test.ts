/**
 * @fileoverview Unit tests for content generation handlers
 *
 * Covers handleGenerateNPC, and handleGenerateLoot.
 * Math.random is stubbed for determinism.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FoundryClient } from '../../../foundry/client.js';
import { handleGenerateLoot, handleGenerateNPC } from '../generation.js';

// The handlers do not call any FoundryClient methods, so an empty stub suffices.
const stubClient = {} as unknown as FoundryClient;

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('handleGenerateNPC', () => {
  beforeEach(() => {
    // Math.random returns 0.5 → middle-of-array picks, deterministic ability scores
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('returns a formatted NPC with default level when no args given', async () => {
      const result = await handleGenerateNPC({}, stubClient);
      const text = getText(result);

      expect(text).toContain('Generated NPC');
      expect(text).toContain('**Level:** 1');
      expect(text).toContain('**Name:**');
      expect(text).toContain('**Race:**');
      expect(text).toContain('**Class:**');
      expect(text).toContain('**Hit Points:**');
      expect(text).toContain('**STR:**');
      expect(text).toContain('**DEX:**');
      expect(text).toContain('**CON:**');
      expect(text).toContain('**INT:**');
      expect(text).toContain('**WIS:**');
      expect(text).toContain('**CHA:**');
      expect(text).toContain('**Background:**');
    });
  });

  describe('edge cases', () => {
    it('honors caller-supplied race, class, and level', async () => {
      const result = await handleGenerateNPC(
        { level: 5, race: 'Dwarf', class: 'Wizard' },
        stubClient,
      );
      const text = getText(result);

      expect(text).toContain('**Level:** 5');
      expect(text).toContain('**Race:** Dwarf');
      expect(text).toContain('**Class:** Wizard');
    });
  });
});

describe('handleGenerateLoot', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('happy path', () => {
    it('returns formatted loot with default CR=1 and treasureType=individual', async () => {
      const result = await handleGenerateLoot({}, stubClient);
      const text = getText(result);

      expect(text).toContain('Generated Loot');
      expect(text).toContain('**Challenge Rating:** 1');
      expect(text).toContain('**Treasure Type:** individual');
      expect(text).toContain('**Currency:**');
      expect(text).toContain('**Items:**');
      expect(text).toContain('**Total Estimated Value:**');
      expect(text).toContain('gp');
    });
  });

  describe('edge cases', () => {
    it('honors caller-supplied challengeRating and treasureType', async () => {
      const result = await handleGenerateLoot(
        { challengeRating: 10, treasureType: 'hoard' },
        stubClient,
      );
      const text = getText(result);

      expect(text).toContain('**Challenge Rating:** 10');
      expect(text).toContain('**Treasure Type:** hoard');
    });
  });
});

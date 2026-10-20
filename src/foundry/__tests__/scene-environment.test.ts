import { describe, expect, it } from 'vitest';
import { sceneDarkness, sceneGlobalLight } from '../client.js';

describe('scene environment accessors', () => {
  it('reads v12+ environment fields', () => {
    const s = { environment: { darknessLevel: 0.65, globalLight: { enabled: true } } };
    expect(sceneDarkness(s)).toBe(0.65);
    expect(sceneGlobalLight(s)).toBe(true);
  });

  it('falls back to legacy top-level fields', () => {
    expect(sceneDarkness({ darkness: 0.3 })).toBe(0.3);
    expect(sceneGlobalLight({ globalLight: true })).toBe(true);
  });

  it('never returns NaN', () => {
    expect(sceneDarkness({})).toBe(0);
    expect(sceneDarkness({ environment: { darknessLevel: Number.NaN } })).toBe(0);
  });
});

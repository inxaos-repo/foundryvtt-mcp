import { describe, expect, it } from 'vitest';
import { buildTokenMovement } from '../token-movement.js';

describe('buildTokenMovement', () => {
  it('marks route corners explicit so clients animate along them', () => {
    const { movement } = buildTokenMovement(
      { _id: 't1', x: 0, y: 0, width: 1, height: 1 },
      { _id: 't1', x: 300, y: 100 },
      'u1',
      { gridSize: 100, waypoints: [{ x: 0, y: 100 }] },
    );
    const passed = (movement.passed as { waypoints: Array<Record<string, unknown>> }).waypoints;
    expect(passed).toHaveLength(2);
    expect(passed[0]).toMatchObject({ x: 0, y: 100, intermediate: true, explicit: true });
    expect(passed[1]).toMatchObject({ x: 300, y: 100, intermediate: false });
  });
});

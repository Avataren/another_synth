import { describe, expect, it } from 'vitest';
import { ballOffscreenX } from 'src/components/tracker/raymarch-renderer';

/** The ball's nearest edge, as an angle from the camera's axis, against the half field of view. */
function nearestEdgeAngle(x: number, depth: number, radius: number): number {
  const rho = Math.hypot(x, depth);
  return Math.atan(x / depth) - Math.asin(radius / rho);
}

describe('ballOffscreenX', () => {
  it('puts the whole ball outside the view, at any aspect', () => {
    for (const aspect of [0.8, 1.5, 2.3, 4, 7, 10]) {
      for (const depth of [4, 7, 12]) {
        const tanHalf = Math.tan((34 * Math.PI) / 180 / 2) * aspect;
        const x = ballOffscreenX(depth, tanHalf, 0.9);
        expect(nearestEdgeAngle(x, depth, 0.9)).toBeGreaterThanOrEqual(Math.atan(tanHalf));
      }
    }
  });

  it('needs more room than a flat margin on a very wide view', () => {
    const depth = 8;
    const tanHalf = Math.tan((34 * Math.PI) / 180 / 2) * 8;
    const flat = depth * tanHalf + 0.9 * 1.6;
    expect(ballOffscreenX(depth, tanHalf, 0.9)).toBeGreaterThan(flat);
  });
});

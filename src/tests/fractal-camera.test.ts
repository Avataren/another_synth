import { describe, expect, it } from 'vitest';
import {
  MIN_BULB_DISTANCE,
  MIN_EYE_Y,
  MIN_GLASS_DISTANCE,
  SHOT_KINDS,
  SHOT_SECONDS,
  fractalCamera,
  glassPosition,
  shotKind,
} from 'src/components/tracker/fractal-camera';
import {
  exposureFor,
  unpackLuminance,
} from 'src/components/tracker/fractal-renderer';

describe('fractal camera', () => {
  it('stays out of the floor, the bulb and the glass, with finite numbers', () => {
    for (let t = 0; t < 900; t += 0.37) {
      for (const bass of [0, 1]) {
        const cam = fractalCamera(t, bass);
        const [x, y, z] = cam.eye;
        expect([...cam.eye, ...cam.look, cam.fovY].every(Number.isFinite)).toBe(true);
        expect(y).toBeGreaterThanOrEqual(MIN_EYE_Y - 1e-9);
        expect(Math.hypot(x, y, z)).toBeGreaterThanOrEqual(MIN_BULB_DISTANCE - 1e-6);
        const g = glassPosition(t);
        expect(Math.hypot(x - g[0], y - g[1], z - g[2])).toBeGreaterThanOrEqual(MIN_GLASS_DISTANCE - 1e-6);
      }
    }
  });

  it('cycles through every kind of shot and never repeats one back to back', () => {
    const seen = new Set<number>();
    let previous = -1;
    for (let i = 0; i < SHOT_KINDS * 40; i++) {
      const kind = shotKind(i);
      expect(kind).not.toBe(previous);
      previous = kind;
      seen.add(kind);
    }
    expect(seen.size).toBe(SHOT_KINDS);
    expect(fractalCamera(SHOT_SECONDS * 3 + 1, 0).kind).toBe(shotKind(3));
  });
});

describe('fractal auto exposure', () => {
  it('lifts a dark picture, darkens a bright one, within its limits', () => {
    expect(exposureFor(0.005)).toBeGreaterThan(1);
    expect(exposureFor(2)).toBeLessThan(1);
    expect(exposureFor(0)).toBeLessThanOrEqual(1.25);
    expect(exposureFor(1e6)).toBeGreaterThanOrEqual(0.3);
  });

  it('unpacks black to zero and brighter packed values to brighter light', () => {
    expect(unpackLuminance(0, 0, 0)).toBe(0);
    expect(unpackLuminance(200, 200, 200)).toBeGreaterThan(unpackLuminance(100, 100, 100));
  });
});

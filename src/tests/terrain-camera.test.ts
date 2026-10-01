import { describe, expect, it } from 'vitest';
import {
  MAX_DISTANCE,
  MAX_FOV,
  MAX_HEIGHT_PER_DISTANCE,
  MAX_HEIGHT,
  MIN_DISTANCE,
  MIN_FOV,
  MIN_HEIGHT,
  bottomEdgeReach,
  terrainCamera,
} from 'src/components/tracker/terrain-camera';

const VENT_Z = -6.3;
const SPAN = 1200; // seconds: several turns of the slowest drifts
const STEP = 0.5;

describe('terrainCamera', () => {
  it('stays inside its ranges', () => {
    for (let t = 0; t < SPAN; t += STEP) {
      const c = terrainCamera(t, VENT_Z);
      expect(c.height).toBeGreaterThanOrEqual(MIN_HEIGHT - 1e-9);
      expect(c.height).toBeLessThanOrEqual(MAX_HEIGHT + 1e-9);
      expect(c.distance).toBeGreaterThanOrEqual(MIN_DISTANCE - 1e-9);
      expect(c.distance).toBeLessThanOrEqual(MAX_DISTANCE + 1e-9);
      expect(c.fovY).toBeGreaterThanOrEqual(MIN_FOV - 1e-9);
      expect(c.fovY).toBeLessThanOrEqual(MAX_FOV + 1e-9);
      expect(c.eye[2]).toBeCloseTo(VENT_Z + c.distance, 9);
    }
  });

  it('keeps the bottom edge of the frame at or before the vent, so the music always shows at the bottom', () => {
    for (let t = 0; t < SPAN; t += STEP) {
      const c = terrainCamera(t, VENT_Z);
      expect(bottomEdgeReach(c)).toBeLessThanOrEqual(c.distance + 1e-6);
    }
  });

  it('always looks well ahead, never steeply down at the water: not high and close at once', () => {
    let steepest = 0;
    for (let t = 0; t < SPAN; t += STEP) {
      const c = terrainCamera(t, VENT_Z);
      expect(c.height).toBeLessThanOrEqual(c.distance * MAX_HEIGHT_PER_DISTANCE + 1e-9);
      const dy = c.look[1] - c.eye[1];
      const pitchDown = Math.atan2(-dy, Math.hypot(c.look[0] - c.eye[0], c.look[2] - c.eye[2]));
      steepest = Math.max(steepest, pitchDown);
    }
    expect(steepest).toBeLessThan((20 * Math.PI) / 180);
  });

  it('moves smoothly: no jumps between frames', () => {
    let prev = terrainCamera(0, VENT_Z);
    for (let t = 1 / 60; t < 120; t += 1 / 60) {
      const c = terrainCamera(t, VENT_Z);
      expect(Math.hypot(c.eye[0] - prev.eye[0], c.eye[1] - prev.eye[1], c.eye[2] - prev.eye[2])).toBeLessThan(0.05);
      expect(Math.abs(c.fovY - prev.fovY)).toBeLessThan(0.005);
      prev = c;
    }
  });

  it('really does come close and back away, and changes the field of view', () => {
    let nearest = Infinity;
    let farthest = -Infinity;
    let narrow = Infinity;
    let wide = -Infinity;
    for (let t = 0; t < SPAN; t += STEP) {
      const c = terrainCamera(t, VENT_Z);
      nearest = Math.min(nearest, c.distance);
      farthest = Math.max(farthest, c.distance);
      narrow = Math.min(narrow, c.fovY);
      wide = Math.max(wide, c.fovY);
    }
    expect(farthest - nearest).toBeGreaterThan(4);
    expect(wide - narrow).toBeGreaterThan(0.15);
  });
});

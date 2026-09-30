import { describe, expect, it } from 'vitest';
import {
  BACK_LANE_Z,
  BALL_RADIUS,
  BOUNCE_SECONDS,
  SEA_LIFT,
  FRONT_LANE_Z,
  PASS_PERIOD,
  passSeconds,
  ballState,
  bounceSeconds,
  passPlan,
} from 'src/components/tracker/ball-motion';

/** Stands in for the renderer's "fully out of sight" distance. */
const halfWidth = () => 6;

describe('bouncing ball', () => {
  it('takes longer to cross a wider canvas, within limits', () => {
    expect(passSeconds(2)).toBe(8);
    expect(passSeconds(15)).toBeCloseTo(10, 6);
    expect(passSeconds(200)).toBe(18);
    expect(passSeconds(15)).toBeLessThan(PASS_PERIOD);
  });

  it('is off screen between passes and on screen during one', () => {
    expect(ballState(1, halfWidth).visible).toBe(true);
    expect(ballState(passSeconds(6) + 1, halfWidth).visible).toBe(false);
    expect(ballState(PASS_PERIOD + 1, halfWidth).visible).toBe(true);
  });

  it('starts and ends beyond the edges of the canvas, on opposite sides', () => {
    for (let pass = 0; pass < 6; pass++) {
      const t0 = pass * PASS_PERIOD;
      const start = ballState(t0, halfWidth);
      const end = ballState(t0 + passSeconds(6), halfWidth);
      expect(Math.abs(start.x)).toBeCloseTo(6, 6);
      expect(Math.abs(end.x)).toBeCloseTo(6, 6);
      expect(Math.sign(start.x)).toBe(-Math.sign(end.x));
      expect(Math.sign(start.x)).toBe(-start.direction);
    }
  });

  it('travels steadily the same way across a pass', () => {
    const xs = Array.from({ length: 20 }, (_, i) => ballState((i / 19) * passSeconds(6), halfWidth).x);
    const d = ballState(0, halfWidth).direction;
    for (let i = 1; i < xs.length; i++) expect((xs[i]! - xs[i - 1]!) * d).toBeGreaterThan(0);
  });

  it('bounces: never below the floor, and back on it every bounce', () => {
    for (let i = 0; i < 200; i++) {
      const s = ballState((i / 200) * passSeconds(6), halfWidth);
      expect(s.y).toBeGreaterThanOrEqual(SEA_LIFT + BALL_RADIUS - 1e-6);
    }
    expect(ballState(BOUNCE_SECONDS * 2, halfWidth).y).toBeCloseTo(SEA_LIFT + BALL_RADIUS, 4);
    expect(ballState(BOUNCE_SECONDS * 2.5, halfWidth).y).toBeGreaterThan(SEA_LIFT + BALL_RADIUS + 1.5);
  });

  it('follows the tempo with a bounce every beat or a simple multiple of it', () => {
    expect(bounceSeconds(120)).toBeCloseTo(1.0, 6);
    expect(bounceSeconds(60)).toBeCloseTo(1.0, 6);
    expect(bounceSeconds(150)).toBeCloseTo(0.4 * 4, 6);
    expect(bounceSeconds(180)).toBeCloseTo((2 / 3) * 2, 6);
    for (let bpm = 40; bpm <= 300; bpm += 7) {
      const s = bounceSeconds(bpm);
      expect(s).toBeGreaterThanOrEqual(0.9 - 1e-9);
      expect(s).toBeLessThanOrEqual(2.0 + 1e-9);
      // A whole number of beats (or a whole number of bounces per beat).
      const beats = s / (60 / bpm);
      expect(Math.abs(Math.log2(beats) - Math.round(Math.log2(beats)))).toBeLessThan(1e-9);
    }
    expect(bounceSeconds(0)).toBeGreaterThan(0);
  });

  it('bounces at the count it is given: on the floor at whole numbers, at the top between', () => {
    expect(ballState(3, halfWidth, 7).y).toBeCloseTo(SEA_LIFT + BALL_RADIUS, 6);
    expect(ballState(3, halfWidth, 7.5).y).toBeGreaterThan(SEA_LIFT + BALL_RADIUS + 1.5);
  });

  it('uses both lanes, in front of the bars and behind them, across passes', () => {
    const lanes = new Set(Array.from({ length: 40 }, (_, i) => passPlan(i).lane));
    expect(lanes.has('front')).toBe(true);
    expect(lanes.has('back')).toBe(true);
    const s = ballState(3, halfWidth);
    expect(s.z).toBe(s.lane === 'front' ? FRONT_LANE_Z : BACK_LANE_Z);
    const sides = new Set(Array.from({ length: 40 }, (_, i) => passPlan(i).direction));
    expect(sides.size).toBe(2);
  });

  it('gives a proper rotation: orthonormal columns', () => {
    const r = ballState(4.2, halfWidth).rotation;
    const col = (i: number) => [r[i * 3]!, r[i * 3 + 1]!, r[i * 3 + 2]!];
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
    for (let i = 0; i < 3; i++) {
      expect(dot(col(i), col(i))).toBeCloseTo(1, 5);
      for (let j = i + 1; j < 3; j++) expect(dot(col(i), col(j))).toBeCloseTo(0, 5);
    }
  });
});

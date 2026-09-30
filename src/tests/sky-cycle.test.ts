import { describe, expect, it } from 'vitest';
import { CYCLE_SECONDS, airMass, skyState } from 'src/components/tracker/sky-cycle';

/** Times on the clock, with the day starting exactly at sunrise. */
const at = (fraction: number) => skyState(fraction * CYCLE_SECONDS, 0);

describe('sky cycle', () => {
  it('rises at sunrise, peaks at a quarter day, sets at half, is lowest at three quarters', () => {
    expect(at(0).sunElevation).toBeCloseTo(0, 5);
    expect(at(0.25).sunElevation).toBeGreaterThan(0.3);
    expect(at(0.5).sunElevation).toBeCloseTo(0, 5);
    expect(at(0.75).sunElevation).toBeLessThan(-0.3);
  });

  it('puts the moon opposite the sun in height, so one is up while the other is down', () => {
    for (const f of [0.1, 0.25, 0.4, 0.6, 0.75, 0.9]) {
      const s = at(f);
      expect(s.moonDir[1]).toBeCloseTo(-s.sunDir[1], 6);
    }
  });

  it('returns unit direction vectors', () => {
    const s = at(0.33);
    for (const v of [s.sunDir, s.moonDir, s.keyDir]) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    }
  });

  it('is day at noon and night at midnight, and only lights the stars and aurora at night', () => {
    const noon = at(0.25);
    const midnight = at(0.75);
    expect(noon.day).toBeGreaterThan(0.95);
    expect(noon.night).toBe(0);
    expect(noon.aurora).toBe(0);
    expect(midnight.night).toBe(1);
    expect(midnight.day).toBe(0);
  });

  it('shows the aurora only for a short stretch of the night', () => {
    expect(at(0.83).aurora).toBeGreaterThan(0.6);
    expect(at(0.6).aurora).toBe(0);
    expect(at(0.97).aurora).toBe(0);
    const nightSamples = Array.from({ length: 100 }, (_, i) => at(0.5 + (i / 100) * 0.5));
    const up = nightSamples.filter((s) => s.aurora > 0.05).length;
    expect(up).toBeGreaterThan(5);
    expect(up).toBeLessThan(25);
  });

  it('reddens the sun near the horizon and leaves it near white overhead', () => {
    const low = at(0.02).sunColor;
    const high = at(0.25).sunColor;
    expect(low[0] / low[2]).toBeGreaterThan(high[0] / high[2] * 2);
    expect(high[0] / high[2]).toBeLessThan(2);
  });

  it('has no sunlight at night and no moonlight by day', () => {
    const night = at(0.75);
    expect(night.sunColor).toEqual([0, 0, 0]);
    expect(Math.max(...night.moonColor)).toBeGreaterThan(0.1);
    const day = at(0.25);
    expect(day.moonColor).toEqual([0, 0, 0]);
  });

  it('keys the clouds off the sun by day and the moon at night', () => {
    const day = at(0.25);
    expect(day.keyDir[1]).toBeGreaterThan(0.3);
    const night = at(0.75);
    expect(night.keyDir[1]).toBeGreaterThan(0.3);
    expect(night.keyDir[1]).toBeCloseTo(night.moonDir[1], 2);
  });

  it('repeats every cycle', () => {
    const a = skyState(12.5, 0.1);
    const b = skyState(12.5 + CYCLE_SECONDS, 0.1);
    expect(b.sunElevation).toBeCloseTo(a.sunElevation, 6);
  });

  it('has a longer air path near the horizon', () => {
    expect(airMass(0)).toBeGreaterThan(20);
    expect(airMass(1)).toBeCloseTo(1, 1);
  });
});

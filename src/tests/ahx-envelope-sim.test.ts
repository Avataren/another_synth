// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AhxEnvelope } from '@another-synth/tracker-playback';
import { simulateAhxEnvelope } from 'src/audio/tracker/ahx-envelope-sim';
import { ahxEnvelopePoints } from 'src/audio/tracker/ahx-instrument-display';
import parity from './fixtures/ahx-envelope-parity.json';

const asEnv = (c: number[]): AhxEnvelope => ({
  aFrames: c[0]!,
  aVolume: c[1]!,
  dFrames: c[2]!,
  dVolume: c[3]!,
  sFrames: c[4]!,
  rFrames: c[5]!,
  rVolume: c[6]!,
});

/**
 * The simulation stops a few frames after the last stage; Rust was stepped
 * further. Every simulated frame must match, and past its end the Rust level
 * must have stopped moving (nothing more happens to the envelope).
 */
function expectSameLevels(sim: number[], rust: number[]): void {
  expect(rust.length).toBeGreaterThanOrEqual(sim.length);
  expect(sim).toEqual(rust.slice(0, sim.length));
  const last = sim[sim.length - 1]!;
  for (const level of rust.slice(sim.length)) expect(level).toBe(last);
}

describe('simulateAhxEnvelope (E1): parity with rust-wasm/src/ahx/envelope.rs', () => {
  // The fixture is dumped from the real envelope.rs (ahx-envelope-parity.gen.rs.txt), level by level.
  it.each(parity.cases.map((c, i) => [i, c] as const))('case %i: every frame\'s level equals the Rust stepper', (_i, c) => {
    const sim = simulateAhxEnvelope(asEnv(c.env), 64);
    expectSameLevels(sim.samples.map((s) => s.level), c.levels);
  });

  it.each(parity.cuts.map((c, i) => [i, c] as const))('hard cut %i: the forced release matches AdsrState::hard_cut_release', (_i, c) => {
    const sim = simulateAhxEnvelope(asEnv(c.env), 64, { before: c.before, frames: c.frames, release: true });
    expectSameLevels(sim.samples.map((s) => s.level), c.levels);
  });

  it('a hard cut with the release off mutes the output from the cut instead of ramping', () => {
    const env = asEnv([2, 64, 4, 40, 10, 6, 0]);
    const sim = simulateAhxEnvelope(env, 64, { before: 5, frames: 3, release: false });
    expect(sim.samples[5]!.output).toBeGreaterThan(0);
    expect(sim.samples[6]!.output).toBe(0);
    expect(sim.samples[12]!.output).toBe(0);
  });

  it('frames 0 is a hard cut with no effect', () => {
    const env = asEnv([2, 64, 4, 40, 10, 6, 0]);
    const plain = simulateAhxEnvelope(env, 64);
    expect(simulateAhxEnvelope(env, 64, { before: 3, frames: 0, release: true }).samples).toEqual(plain.samples);
  });
});

describe('simulateAhxEnvelope (E1): what the engine does that the four numbers do not say', () => {
  it('a normal envelope is exactly the ideal polyline, so nothing is drawn dotted', () => {
    const env: AhxEnvelope = { aFrames: 2, aVolume: 64, dFrames: 4, dVolume: 40, sFrames: 10, rFrames: 6, rVolume: 0 };
    const sim = simulateAhxEnvelope(env);
    expect(sim.differs).toBe(false);
    expect(sim.endFrame).toBe(22);
    expect(sim.ideal).toEqual(ahxEnvelopePoints(env));
    expect(sim.samples[2]!.level).toBe(64 << 8);
    expect(sim.samples[6]!.level).toBe(40 << 8);
    expect(sim.samples[22]!.level).toBe(0);
  });

  it('a zero-frame attack is skipped: the decay ramps up from 0 by (d-a)/dFrames and snaps to the decay level', () => {
    // aFrames 0, aVolume 32, dFrames 5, dVolume 48: step = (48-32)*256/5 = 819 per frame from a REAL 0.
    const sim = simulateAhxEnvelope({ aFrames: 0, aVolume: 32, dFrames: 5, dVolume: 48, sFrames: 3, rFrames: 4, rVolume: 8 });
    expect(sim.samples.slice(0, 6).map((s) => s.level)).toEqual([0, 819, 1638, 2457, 3276, 48 << 8]);
    expect(sim.differs).toBe(true);
    // The ideal polyline would have jumped to 32 at frame 0.
    expect(sim.ideal[1]).toEqual({ frame: 0, volume: 32 });
  });

  it('a zero-frame decay is skipped: the sustain holds the attack level, not the decay level', () => {
    const sim = simulateAhxEnvelope({ aFrames: 3, aVolume: 60, dFrames: 0, dVolume: 20, sFrames: 6, rFrames: 5, rVolume: 0 });
    for (const frame of [3, 4, 8]) expect(sim.samples[frame]!.level).toBe(60 << 8);
    expect(sim.differs).toBe(true);
  });

  it('a zero-frame release never releases: the level holds to the end', () => {
    const sim = simulateAhxEnvelope({ aFrames: 2, aVolume: 50, dFrames: 3, dVolume: 30, sFrames: 4, rFrames: 0, rVolume: 0 });
    const last = sim.samples[sim.samples.length - 1]!;
    expect(last.level).toBe(30 << 8);
  });

  it('neither attack nor decay: never rises, then the release swings towards -50 and lands on the release level', () => {
    const sim = simulateAhxEnvelope({ aFrames: 0, aVolume: 64, dFrames: 0, dVolume: 64, sFrames: 1, rFrames: 8, rVolume: 0 });
    expect(sim.lowest).toBeLessThanOrEqual(-50 * 256);
    expect(sim.samples[sim.samples.length - 1]!.level).toBe(0);
    expect(sim.samples.slice(0, 2).map((s) => s.level)).toEqual([0, 0]);
  });

  it('the instrument volume scales the output like voice.rs: ((level >> 8) * volume) >> 6', () => {
    const sim = simulateAhxEnvelope({ aFrames: 1, aVolume: 64, dFrames: 0, dVolume: 0, sFrames: 5, rFrames: 1, rVolume: 0 }, 32);
    expect(sim.samples[1]!.level).toBe(64 << 8);
    expect(sim.samples[1]!.output).toBe(32);
  });
});

import { describe, expect, it } from 'vitest';
import { DRUM_KINDS, DRUM_PRESETS, generateDrum } from 'src/audio/tracker/mod-drum-synth';
import { emptyModSample } from 'src/audio/tracker/mod-sample-codec';
import { generatePulse } from 'src/audio/tracker/mod-sample-ops';

const peak = (d: Int8Array) => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Share of the energy that is high-frequency: sample-to-sample change over level. */
const brightness = (d: Int8Array) => {
  let diff = 0;
  let level = 0;
  for (let i = 1; i < d.length; i++) {
    diff += Math.abs(d[i]! - d[i - 1]!);
    level += Math.abs(d[i]!) + Math.abs(d[i - 1]!);
  }
  return diff / Math.max(1, level / 2);
};

describe('drum synth', () => {
  it('makes a normalised, non-silent, whole-word sample of every kind', () => {
    for (const kind of DRUM_KINDS) {
      const d = generateDrum(kind, DRUM_PRESETS[kind], 214);
      expect(d.length, kind).toBeGreaterThan(64);
      expect(d.length % 2, kind).toBe(0);
      expect(peak(d), kind).toBeGreaterThanOrEqual(120);
    }
  });

  it('is deterministic for a seed and varies with it', () => {
    const a = generateDrum('snare', DRUM_PRESETS.snare, 214, 7);
    expect(Array.from(generateDrum('snare', DRUM_PRESETS.snare, 214, 7))).toEqual(Array.from(a));
    expect(Array.from(generateDrum('snare', DRUM_PRESETS.snare, 214, 8))).not.toEqual(Array.from(a));
  });

  it('hats are brighter than a kick, and decay sets the length', () => {
    const kick = generateDrum('kick', DRUM_PRESETS.kick, 214);
    const hat = generateDrum('hihat', DRUM_PRESETS.hihat, 214);
    expect(brightness(hat)).toBeGreaterThan(brightness(kick) * 3);
    expect(generateDrum('openhat', DRUM_PRESETS.openhat, 214).length).toBeGreaterThan(hat.length * 3);
  });

  it('a kick falls in amplitude and ends quiet', () => {
    const kick = generateDrum('kick', DRUM_PRESETS.kick, 214);
    const tail = kick.subarray(kick.length - 200);
    expect(peak(tail)).toBeLessThan(20);
  });
});

describe('pulse width modulation', () => {
  const base = { cycleLength: 32, cycles: 8, dutyStart: 10, dutyEnd: 50 };
  const widths = (d: Int8Array, cycle: number) =>
    Array.from({ length: d.length / cycle }, (_, c) => d.subarray(c * cycle, (c + 1) * cycle).filter((v) => v > 0).length);

  it('sweeps the width across the cycles and loops the whole sample', () => {
    const s = generatePulse(emptyModSample(), { ...base, sweep: 'up' });
    expect(s.data.length).toBe(256);
    expect([s.loopStart, s.loopLength]).toEqual([0, 256]);
    const w = widths(s.data, 32);
    expect(w[0]).toBeLessThan(w[7]!);
    expect(w[0]).toBe(3);
    expect(w[7]).toBe(16);
  });

  it('ping-pong returns to the start width for a seamless loop', () => {
    const w = widths(generatePulse(emptyModSample(), { ...base, sweep: 'pingpong' }).data, 32);
    expect(w[0]).toBe(3);
    expect(Math.max(...w)).toBeGreaterThan(12);
    expect(w[7]!).toBeLessThan(Math.max(...w));
  });

  it('equal start and end is a plain pulse', () => {
    const w = widths(generatePulse(emptyModSample(), { ...base, dutyStart: 25, dutyEnd: 25, sweep: 'up' }).data, 32);
    expect(new Set(w)).toEqual(new Set([8]));
  });
});

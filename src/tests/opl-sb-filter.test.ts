// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  OPL_TAP_OUTPUTS,
  OplProcessorCore,
  SbOutputFilter,
  type A2WasmPlayer,
  type A2WasmPlayerCtor,
  type OplWasmRenderer,
  type OplWasmRendererCtor,
} from 'src/audio/worklets/opl-core';

/**
 * The Sound Blaster OPL output low-pass (.ai/notes-opl-sb-filter.md): a
 * Butterworth low-pass on the worklet's stereo mix, SB Pro 2 (1st order,
 * 8 kHz) by default, set by `set-filter`. Driven over fake chips that play a
 * known sine so the response can be measured exactly.
 */

const SAMPLE_RATE = 48000;
const QUANTUM = 128;

/** The sine every fake chip plays, on both sides and on tap 0. */
let toneHz = 440;

function sine(phase: { n: number }, out: Float32Array, right?: Float32Array): void {
  for (let i = 0; i < out.length; i++) {
    const v = 0.5 * Math.sin((2 * Math.PI * toneHz * phase.n) / SAMPLE_RATE);
    out[i] = v;
    if (right) right[i] = v;
    phase.n++;
  }
}

class FakeRenderer implements OplWasmRenderer {
  private readonly phase = { n: 0 };
  private lastLeft = new Float32Array(0);
  write(): void {}
  write_at(): void {}
  render(left: Float32Array, right: Float32Array): number {
    sine(this.phase, left, right);
    this.lastLeft = left.slice();
    return left.length;
  }
  frames_rendered(): number {
    return this.phase.n;
  }
  late_writes(): number {
    return 0;
  }
  queued_writes(): number {
    return 0;
  }
  set_gain(): void {}
  set_channel_mask(): void {}
  set_taps_enabled(): void {}
  read_tap(ch: number, out: Float32Array): void {
    if (ch === 0) out.set(this.lastLeft);
  }
  panic(): void {}
  free(): void {}
}

class FakeSong implements A2WasmPlayer {
  private readonly phase = { n: 0 };
  private playing = false;
  play(): void {
    this.playing = true;
  }
  pause(): void {
    this.playing = false;
  }
  is_playing(): boolean {
    return this.playing;
  }
  set_gain(): void {}
  render(left: Float32Array, right: Float32Array): number {
    if (this.playing) sine(this.phase, left, right);
    else {
      left.fill(0);
      right.fill(0);
    }
    return left.length;
  }
  seek(): boolean {
    return true;
  }
  set_loop_order(): void {}
  song_end_reached(): boolean {
    return false;
  }
  set_mute_solo(): void {}
  set_taps_enabled(): void {}
  read_tap(): void {}
  track_channel(track: number): number {
    return track;
  }
  track_count(): number {
    return 1;
  }
  order_count(): number {
    return 1;
  }
  order_entry(): number {
    return 0;
  }
  rows_per_pattern(): number {
    return 64;
  }
  order(): number {
    return 0;
  }
  pattern(): number {
    return 0;
  }
  row(): number {
    return 0;
  }
  refresh(): number {
    return 50;
  }
  song_name(): string {
    return 'fake';
  }
  composer(): string {
    return '';
  }
  version(): number {
    return 14;
  }
  instrument_count(): number {
    return 0;
  }
  instrument_name(): string {
    return '';
  }
  pattern_cells(): Uint8Array {
    return new Uint8Array(64 * 6);
  }
  free(): void {}
}

function newCore(): OplProcessorCore {
  return new OplProcessorCore(
    FakeRenderer as OplWasmRendererCtor,
    SAMPLE_RATE,
    0,
    () => {},
    FakeSong as unknown as A2WasmPlayerCtor,
  );
}

/** Renders `frames` in quanta; returns left, right and tap 0. */
function render(core: OplProcessorCore, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const tap = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const taps = Array.from({ length: OPL_TAP_OUTPUTS }, (_, ch) => (ch === 0 ? tap.subarray(at, at + QUANTUM) : undefined));
    core.process(left.subarray(at, at + QUANTUM), right.subarray(at, at + QUANTUM), at, taps);
  }
  return { left, right, tap };
}

/**
 * Sine amplitude (RMS · √2) after the first 1024 frames, past the filter's
 * start-up; a sampled peak would depend on the filter's phase shift.
 */
function steadyPeak(x: Float32Array): number {
  const tail = x.subarray(1024);
  const sum = tail.reduce((s, v) => s + v * v, 0);
  return Math.sqrt((2 * sum) / tail.length);
}

/** Steady-state gain of the core's output at `hz`, relative to the 0.5 input. */
function gainAt(hz: number, setup?: (core: OplProcessorCore) => void): number {
  toneHz = hz;
  const core = newCore();
  setup?.(core);
  return steadyPeak(render(core, 8192).left) / 0.5;
}

/** Analytic magnitude of the 1st-order bilinear Butterworth. */
function firstOrderGain(hz: number, fc: number): number {
  const k = Math.tan((Math.PI * fc) / SAMPLE_RATE);
  const w = Math.tan((Math.PI * hz) / SAMPLE_RATE);
  return 1 / Math.sqrt(1 + (w / k) ** 2);
}

describe('Sound Blaster OPL output filter', () => {
  it('is on by default as the SB Pro 2 (1st order, 8 kHz): highs lose more than lows', () => {
    const low = gainAt(200);
    const high = gainAt(12000);
    expect(low).toBeGreaterThan(0.99);
    expect(high).toBeLessThan(0.7);
    expect(gainAt(8000)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(high).toBeCloseTo(firstOrderGain(12000, 8000), 2);
  });

  it('passes the chip through untouched on sb16, none, or enabled: false', () => {
    for (const command of [{ preset: 'sb16' as const }, { preset: 'none' as const }, { enabled: false }]) {
      toneHz = 12000;
      const plain = new Float32Array(8192);
      sine({ n: 0 }, plain);
      const core = newCore();
      core.handle({ type: 'set-filter', ...command });
      const { left, right } = render(core, 8192);
      expect(Array.from(left)).toEqual(Array.from(plain));
      expect(Array.from(right)).toEqual(Array.from(plain));
    }
  });

  it('takes a cutoff override, a preset, and a 2nd-order override', () => {
    const def = gainAt(6000);
    const lower = gainAt(6000, (c) => c.handle({ type: 'set-filter', cutoffHz: 2000 }));
    expect(lower).toBeCloseTo(firstOrderGain(6000, 2000), 2);
    expect(lower).toBeLessThan(def - 0.2);
    const sb1 = gainAt(6000, (c) => c.handle({ type: 'set-filter', preset: 'sb1' }));
    expect(sb1).toBeCloseTo(firstOrderGain(6000, 12000), 2);
    // 2nd order Butterworth: still -3 dB at the cutoff, steeper past it.
    expect(gainAt(8000, (c) => c.handle({ type: 'set-filter', order: 2 }))).toBeCloseTo(Math.SQRT1_2, 2);
    expect(gainAt(16000, (c) => c.handle({ type: 'set-filter', order: 2 }))).toBeLessThan(0.6 * gainAt(16000));
    // Re-enabling after a bypass brings the preset's filter back.
    expect(
      gainAt(12000, (c) => {
        c.handle({ type: 'set-filter', enabled: false });
        c.handle({ type: 'set-filter', enabled: true });
      }),
    ).toBeCloseTo(firstOrderGain(12000, 8000), 2);
  });

  it('leaves the channel scope taps unfiltered', () => {
    toneHz = 12000;
    const core = newCore();
    core.handle({ type: 'set-taps', enabled: true });
    const { left, tap } = render(core, 4096);
    const plain = new Float32Array(4096);
    sine({ n: 0 }, plain);
    expect(Array.from(tap)).toEqual(Array.from(plain));
    expect(steadyPeak(left)).toBeLessThan(0.7 * steadyPeak(tap));
  });

  it('carries its state across quanta: quantum-by-quantum equals one long pass', () => {
    toneHz = 3000;
    const core = newCore();
    const chunked = render(core, 4096).left;
    const whole = new Float32Array(4096);
    sine({ n: 0 }, whole);
    new SbOutputFilter(SAMPLE_RATE).process(whole);
    for (let i = 0; i < whole.length; i++) expect(chunked[i]).toBeCloseTo(whole[i] ?? 0, 6);
  });

  it('switches settings mid-stream without a step', () => {
    toneHz = 100;
    const core = newCore();
    const a = render(core, 2048).left;
    core.handle({ type: 'set-filter', order: 2, cutoffHz: 3000 });
    const b = render(core, 256).left;
    // A 100 Hz sine moves under 0.007 per sample at 0.5 amplitude.
    expect(Math.abs((b[0] ?? 0) - (a[2047] ?? 0))).toBeLessThan(0.01);
    core.handle({ type: 'set-filter', enabled: false });
    core.handle({ type: 'set-filter', enabled: true });
    const c = render(core, 256).left;
    expect(Math.abs((c[0] ?? 0) - (b[255] ?? 0))).toBeLessThan(0.01);
  });

  it('filters the A2M song path too', () => {
    toneHz = 12000;
    const core = newCore();
    core.handle({ type: 'load-a2m', id: 1, bytes: new Uint8Array(16) });
    core.handle({ type: 'play' });
    const on = steadyPeak(render(core, 8192).left);
    expect(on / 0.5).toBeCloseTo(firstOrderGain(12000, 8000), 2);
    core.handle({ type: 'set-filter', preset: 'sb16' });
    expect(steadyPeak(render(core, 8192).left)).toBeGreaterThan(0.49);
  });
});

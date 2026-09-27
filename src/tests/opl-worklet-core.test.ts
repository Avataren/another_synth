// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { OplRenderer, initSync } from '../../public/wasm/audio_processor.js';
import { OPL_TAP_OUTPUTS, OplProcessorCore, type OplEvent, type OplWasmRendererCtor } from 'src/audio/worklets/opl-core';

/**
 * .ai/plan-opl.md O2: the OPL worklet's render-thread core over the REAL wasm
 * (`public/wasm`, rebuilt with `OplRenderer`). This is the worklet boundary
 * contract: register writes stamped in AudioContext seconds in, a stereo
 * quantum out. The browser only adds the `AudioWorkletProcessor` around it.
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 48000;
const QUANTUM = 128;
/** YMF262: 14.31818 MHz / 288. */
const NATIVE_RATE = 14_318_180 / 288;

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

/** A worklet started `startFrame` frames into the context's life. */
function newCore(startFrame = 0) {
  const events: OplEvent[] = [];
  const core = new OplProcessorCore(OplRenderer as unknown as OplWasmRendererCtor, SAMPLE_RATE, startFrame, (e) =>
    events.push(e),
  );
  return { core, events, frame: startFrame };
}

/** Renders `frames` in quanta from context frame `from`; returns left, right. */
function render(core: OplProcessorCore, from: number, frames: number) {
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    core.process(left.subarray(at, at + QUANTUM), right.subarray(at, at + QUANTUM), from + at);
  }
  return { left, right };
}

/** Channel 0 as a held sine (EG type sustain, carrier TL 0, fastest release), at fnum/block, not keyed. */
function sinePatch(fnum: number, block: number): number[][] {
  return [
    [0x20, 0x01],
    [0x23, 0x21],
    [0x40, 0x3f],
    [0x43, 0x00],
    [0x60, 0xf0],
    [0x63, 0xf0],
    [0x80, 0x00],
    [0x83, 0x0f],
    [0xa0, fnum & 0xff],
    [0xb0, (block << 2) | (fnum >> 8)],
  ];
}

const keyOn = (fnum: number, block: number) => [0xb0, 0x20 | (block << 2) | (fnum >> 8)];
const keyOff = (fnum: number, block: number) => [0xb0, (block << 2) | (fnum >> 8)];

/** Flattens (time, [reg, val]) pairs into the command's triples. */
function writes(...entries: Array<[number, number[]]>): Float64Array {
  return new Float64Array(entries.flatMap(([t, [reg, val]]) => [t, reg as number, val as number]));
}

const firstSound = (x: Float32Array) => x.findIndex((v) => Math.abs(v) > 1e-3);

/** Goertzel power of `x` at `hz`. */
function power(x: Float32Array, hz: number): number {
  const c = 2 * Math.cos((2 * Math.PI * hz) / SAMPLE_RATE);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

describe('OplProcessorCore over the real wasm', () => {
  it('sounds a stamped key-on at its context time, in a worklet started mid-context', () => {
    // The worklet came up 5 s into the context; the note is stamped 5.1 s.
    const start = 5 * SAMPLE_RATE;
    const { core } = newCore(start);
    core.handle({ type: 'writes', writes: writes(...sinePatch(0x244, 4).map((w) => [0, w] as [number, number[]])) });
    core.handle({ type: 'writes', writes: writes([5.1, keyOn(0x244, 4)]) });
    const { left, right } = render(core, start, SAMPLE_RATE / 2);
    const onset = firstSound(left);
    // 0.1 s in, plus the resampler's ≈ 0.7 ms group delay.
    expect(onset).toBeGreaterThanOrEqual(0.1 * SAMPLE_RATE + 30);
    expect(onset).toBeLessThanOrEqual(0.1 * SAMPLE_RATE + 36);
    // OPL2-style (NEW=0): both sides carry the channel.
    expect(Array.from(right)).toEqual(Array.from(left));
  });

  it('plays the pitch the F-number asks for', () => {
    const { core } = newCore();
    const [fnum, block] = [0x244, 4];
    const hz = (fnum * NATIVE_RATE * 2 ** block) / 2 ** 20; // ≈ 440 Hz
    core.handle({ type: 'writes', writes: writes(...sinePatch(fnum, block).map((w) => [0, w] as [number, number[]]), [0, keyOn(fnum, block)]) });
    const { left } = render(core, 0, SAMPLE_RATE);
    const tone = left.subarray(4800);
    expect(power(tone, hz)).toBeGreaterThan(1000 * power(tone, hz * 1.06));
    expect(power(tone, hz)).toBeGreaterThan(1000 * power(tone, hz / 1.06));
  });

  it('releases on a stamped key-off, whatever order the batches came in', () => {
    const { core } = newCore();
    const [fnum, block] = [0x244, 4];
    core.handle({ type: 'writes', writes: writes(...sinePatch(fnum, block).map((w) => [0, w] as [number, number[]])) });
    core.handle({ type: 'writes', writes: writes([0.2, keyOff(fnum, block)]) });
    core.handle({ type: 'writes', writes: writes([0.05, keyOn(fnum, block)]) });
    const { left } = render(core, 0, SAMPLE_RATE / 2);
    const peakIn = (a: number, b: number) => left.subarray(a * SAMPLE_RATE, b * SAMPLE_RATE).reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peakIn(0, 0.049)).toBe(0);
    expect(peakIn(0.06, 0.19)).toBeGreaterThan(0.05);
    expect(peakIn(0.3, 0.5)).toBeLessThan(1e-3);
  });

  it('reports writes that arrive after their time', () => {
    const { core, events } = newCore();
    render(core, 0, SAMPLE_RATE);
    core.handle({ type: 'writes', writes: writes([0.5, [0x20, 0x01]], [0.6, [0x23, 0x01]]) });
    render(core, SAMPLE_RATE, SAMPLE_RATE);
    expect(events).toContainEqual({ type: 'late-writes', total: 2 });
  });

  it('panics to silence, and a disposed core renders silence and ignores writes', () => {
    const { core } = newCore();
    const [fnum, block] = [0x244, 4];
    core.handle({ type: 'writes', writes: writes(...sinePatch(fnum, block).map((w) => [0, w] as [number, number[]]), [0, keyOn(fnum, block)], [0, [0x83, 0x00]]) });
    expect(render(core, 0, 4096).left.some((v) => Math.abs(v) > 0.05)).toBe(true);
    core.handle({ type: 'panic' });
    const after = render(core, 4096, SAMPLE_RATE / 4).left;
    expect(after.subarray(after.length - 2048).every((v) => Math.abs(v) < 1e-3)).toBe(true);

    core.handle({ type: 'dispose' });
    expect(core.disposed).toBe(true);
    core.handle({ type: 'writes', writes: writes([0, keyOn(fnum, block)]) });
    const dead = render(core, 0, 1024);
    expect(dead.left.every((v) => v === 0)).toBe(true);
  });

  it('renders into a mono output', () => {
    const { core } = newCore();
    core.handle({ type: 'writes', writes: writes(...sinePatch(0x244, 4).map((w) => [0, w] as [number, number[]]), [0, keyOn(0x244, 4)]) });
    const mono = new Float32Array(QUANTUM * 8);
    for (let at = 0; at < mono.length; at += QUANTUM) core.process(mono.subarray(at, at + QUANTUM), undefined, at);
    expect(mono.some((v) => Math.abs(v) > 0.05)).toBe(true);
  });

  it('mutes by channel mask and scales by gain', () => {
    const [fnum, block] = [0x244, 4];
    const setup = writes(...sinePatch(fnum, block).map((w) => [0, w] as [number, number[]]), [0, keyOn(fnum, block)]);
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

    const a = newCore();
    a.core.handle({ type: 'writes', writes: setup });
    const full = peak(render(a.core, 0, 4096).left);

    const b = newCore();
    b.core.handle({ type: 'set-gain', gain: 0.5 });
    b.core.handle({ type: 'writes', writes: setup });
    expect(peak(render(b.core, 0, 4096).left)).toBeCloseTo(full / 2, 3);

    const c = newCore();
    c.core.handle({ type: 'set-channel-mask', mask: 0x3fffe });
    c.core.handle({ type: 'writes', writes: setup });
    expect(peak(render(c.core, 0, 4096).left)).toBe(0);
  });

  it('fills per-channel scope taps only while they are on, one channel each', () => {
    const [fnum, block] = [0x244, 4];
    const setup = writes(...sinePatch(fnum, block).map((w) => [0, w] as [number, number[]]), [0, keyOn(fnum, block)]);
    const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const { core } = newCore();
    core.handle({ type: 'writes', writes: setup });
    const quantum = (from: number) => {
      const [l, r] = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
      const taps = Array.from({ length: OPL_TAP_OUTPUTS }, () => new Float32Array(QUANTUM));
      core.process(l, r, from, taps);
      return taps;
    };
    // Off: the outputs stay as the browser handed them (zeroed).
    expect(peak(quantum(0)[0]!)).toBe(0);
    core.handle({ type: 'set-taps', enabled: true });
    let taps = quantum(QUANTUM);
    for (let i = 2; i < 8; i++) taps = quantum(i * QUANTUM);
    expect(peak(taps[0]!)).toBeGreaterThan(0.9);
    expect(peak(taps[0]!)).toBeLessThanOrEqual(1);
    expect(taps.slice(1).every((t) => peak(t) === 0)).toBe(true);
  });
});

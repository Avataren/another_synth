// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { SidProcessorCore, type SidEvent, type SidWasmPlayerCtor } from 'src/audio/worklets/sid-core';

/**
 * plan-sid-tracking.md S4: the SID worklet's render-thread core over the REAL
 * wasm (`public/wasm`, rebuilt in this batch with `SidPlayer`), fed the S3
 * chain song file the app saves (`rust-wasm/tests/fixtures/sid/s3-chain.asid`,
 * byte-identical to what `sid-format-chain.test.ts` saves through the store).
 *
 * This is the worklet boundary contract: what the shell (`sid-worklet.ts`)
 * hands the core per quantum (mix, its stereo copy, three voice taps) and the
 * command/event protocol the main thread speaks. The browser only adds the
 * `AudioWorkletProcessor` around it.
 *
 * The chain song (see `helpers/sid-chain-song.ts`): tempo 6 at 50 Hz, so a
 * row is 6 x 882 samples at 44.1 kHz; voice 1 plays A-4 (triangle) from row
 * 0 to its key off at row 16; voice 2 starts C-4 (the arpeggio pulse) at row
 * 8; voice 3 plays A-3 (E-3 +5, filtered saw) from row 10. 6581 chip. The
 * song is 32 rows (every voice's first pass is 32).
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;
const ROW = 6 * 882;
const chainBytes = () => new Uint8Array(readFileSync(resolve(ROOT, 'rust-wasm/tests/fixtures/sid/s3-chain.asid')));

let nextId = 0;

function newCore() {
  const events: SidEvent[] = [];
  const core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, SAMPLE_RATE, (e) => events.push(e));
  return { core, events };
}

/** Renders `frames` in worklet quanta: the mix, its right copy, and the three taps. */
function render(core: SidProcessorCore, frames: number) {
  const mix = new Float32Array(frames);
  const right = new Float32Array(frames);
  const taps = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(mix.subarray(at, at + n), right.subarray(at, at + n), taps.map((t) => t.subarray(at, at + n)));
  }
  return { mix, right, taps };
}

/** Goertzel power of `x` at `hz`. */
function power(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const A4 = (7493 * 985248) / 2 ** 24; // the table register's pitch, 440.03 Hz

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

describe('SidProcessorCore over the real wasm', () => {
  it('loads the app\'s song file and reports it', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    expect(events).toContainEqual({
      type: 'song-loaded',
      id: nextId - 1,
      info: { songRows: 32, channels: 3, chipModel: '6581', instrumentCount: 4, sampleRate: SAMPLE_RATE },
    });
    core.handle({ type: 'load-song', id: nextId++, bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(events.at(-1)).toMatchObject({ type: 'error', id: nextId - 1 });
    expect((events.at(-1) as { message: string }).message).toMatch(/SID load failed: .*ASID/);
    // A stale load id is ignored.
    const count = events.length;
    core.handle({ type: 'load-song', id: 0, bytes: chainBytes() });
    expect(events.length).toBe(count);
  });

  it('is silent until played and after pause; plays audio, both sides the same', () => {
    const { core } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    const idle = render(core, 4410);
    expect(peak(idle.mix)).toBe(0);
    expect(idle.taps.every((t) => peak(t) === 0)).toBe(true);
    core.handle({ type: 'play' });
    const on = render(core, 8 * ROW);
    expect(peak(on.mix)).toBeGreaterThan(0.05);
    expect(Array.from(on.right)).toEqual(Array.from(on.mix));
    expect(on.mix.every((s) => Number.isFinite(s) && Math.abs(s) <= 1)).toBe(true);
    core.handle({ type: 'pause' });
    expect(peak(render(core, 4410).mix)).toBe(0);
  });

  it('the voice taps are the voices: A-4 on tap 1, nothing on tap 2 before its row 8', () => {
    const { core } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    core.handle({ type: 'play' });
    // Rows 1..7: voice 1 holds A-4, voices 2 and 3 have not started.
    render(core, ROW);
    const { taps, mix } = render(core, 6 * ROW);
    expect(power(taps[0]!, A4)).toBeGreaterThan(100 * power(taps[0]!, 466.16));
    expect(peak(taps[0]!)).toBeGreaterThan(0.05);
    expect(peak(taps[1]!)).toBeLessThan(1e-3);
    expect(peak(taps[2]!)).toBeLessThan(1e-3);
    // Voice 1 is all the mix has: the mix is its tap.
    expect(power(mix, A4)).toBeGreaterThan(100 * power(mix, 466.16));
    // Rows 10..15: voice 3's A-3 (220 Hz) is on its own tap.
    render(core, 3 * ROW);
    const later = render(core, 5 * ROW);
    const A3 = A4 / 2;
    // A saw: compare with the semitone above (its own 2nd harmonic IS A-4).
    expect(power(later.taps[2]!, A3)).toBeGreaterThan(100 * power(later.taps[2]!, A3 * 2 ** (1 / 12)));
    expect(peak(later.taps[1]!)).toBeGreaterThan(0.01);
  });

  it('mute and solo drop voices from the mix and their taps', () => {
    const { core } = newCore();
    core.handle({ type: 'set-mute-solo', mute: 0b001, solo: 0 });
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    core.handle({ type: 'play' });
    const { mix, taps } = render(core, 6 * ROW);
    // Only voice 1 plays in rows 0..5, and it is muted: its tap is silent,
    // and so is the mix once the 6581's mixer-DC step (S2's MIX_DC_6581, a
    // ~0.1 transient when the first frame writes the volume) has decayed.
    expect(peak(taps[0]!)).toBe(0);
    expect(peak(mix.subarray(ROW))).toBeLessThan(1e-3);
    expect(peak(mix.subarray(0, ROW))).toBeGreaterThan(0.05);
  });

  it('reports rows as it plays, answers a seek, and ends the song (stop-at-end pauses)', () => {
    const { core, events } = newCore();
    core.handle({ type: 'set-stop-at-end', enabled: true });
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    core.handle({ type: 'play' });
    render(core, 4 * ROW);
    const rows = events.filter((e) => e.type === 'position').map((e) => (e as { row: number }).row);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows).toEqual([...rows].sort((a, b) => a - b));
    expect(rows.at(-1)).toBeGreaterThanOrEqual(3);
    core.handle({ type: 'seek', row: 30 });
    expect(events.at(-1)).toEqual({ type: 'position', row: 30, tempo: 6, seek: true });
    render(core, 3 * ROW);
    expect(events.some((e) => e.type === 'song-end')).toBe(true);
    // Paused at the end: silence from here on.
    expect(peak(render(core, 4410).mix)).toBe(0);
  });

  it('a row loop keeps the song inside its range ("play pattern")', () => {
    const { core, events } = newCore();
    core.handle({ type: 'set-loop-rows', start: 16, end: 32 });
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    core.handle({ type: 'seek', row: 16 });
    core.handle({ type: 'play' });
    render(core, 40 * ROW);
    const rows = events.filter((e) => e.type === 'position').map((e) => (e as { row: number }).row);
    expect(rows.every((r) => r >= 16 && r < 32)).toBe(true);
    expect(events.some((e) => e.type === 'song-end')).toBe(false);
    // Cleared, it plays on past the loop's end.
    core.handle({ type: 'set-loop-rows', start: 0, end: 0 });
    render(core, 20 * ROW);
    expect(events.some((e) => e.type === 'song-end')).toBe(true);
  });

  it('a preview worklet sounds an instrument on a key, without the song', () => {
    const { core, events } = newCore();
    core.handle({ type: 'set-preview', enabled: true });
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    // No key yet: nothing but the 6581's mixer-DC step as the volume is set.
    render(core, 4410);
    expect(peak(render(core, 4410).mix)).toBeLessThan(1e-3);
    core.handle({ type: 'preview-note-on', instrument: 1, note: 57 }); // "Tri lead", A-4
    const held = render(core, 4 * ROW);
    expect(power(held.mix.subarray(ROW), A4)).toBeGreaterThan(100 * power(held.mix.subarray(ROW), 466.16));
    expect(events.filter((e) => e.type === 'position')).toHaveLength(0);
    core.handle({ type: 'preview-note-off' });
    render(core, 20 * ROW);
    // Released (release 4 = 114 ms on the datasheet): gone well within 2 s.
    expect(peak(render(core, 4410).mix)).toBeLessThan(0.01);
  });

  it('dispose frees the player and goes silent', () => {
    const { core } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: chainBytes() });
    core.handle({ type: 'play' });
    core.handle({ type: 'dispose' });
    expect(core.disposed).toBe(true);
    expect(peak(render(core, 4410).mix)).toBe(0);
  });
});

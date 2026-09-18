// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  AhxProcessorCore,
  type AhxEvent,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;

// Load ids only grow within a core; one counter for the file keeps that true.
let nextId = 0;

const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx', name)));

/** FNV-1a-64, the hash the Rust goldens use. */
function fnv(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

/** `[frames_upto, hash]` chunk lines of a golden from `rust-wasm/tests/golden`. */
function goldenChunks(name: string): Array<[number, bigint]> {
  const text = readFileSync(resolve(ROOT, 'rust-wasm/tests/golden', name), 'utf8');
  const chunks: Array<[number, bigint]> = [];
  for (const line of text.split('\n')) {
    const m = /^(\d+) ([0-9a-f]{16})$/.exec(line.trim());
    if (m) chunks.push([Number(m[1]), BigInt('0x' + m[2])]);
  }
  return chunks;
}

function newCore() {
  const events: AhxEvent[] = [];
  const core = new AhxProcessorCore(
    AhxPlayer as unknown as AhxWasmPlayerCtor,
    SAMPLE_RATE,
    (e) => events.push(e),
  );
  return { core, events };
}

/** Renders `frames` in worklet-sized quanta, returning the planar output. */
function render(core: AhxProcessorCore, frames: number) {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  for (let at = 0; at < frames; at += QUANTUM) {
    const n = Math.min(QUANTUM, frames - at);
    core.process(l.subarray(at, at + n), r.subarray(at, at + n));
  }
  return { l, r };
}

beforeAll(() => {
  initSync({
    module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))),
  });
});

describe('AhxProcessorCore over the real wasm', () => {
  it('reproduces the C reference bit-for-bit through the whole worklet path', () => {
    const { core } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    core.handle({ type: 'play' });

    // 44100 Hz, speed multiplier 1: one DecodeFrame is 882 samples.
    let prev = 0;
    for (const [upto, want] of goldenChunks('karma.44100.s2.cap0.txt').slice(0, 10)) {
      const frames = (upto - prev) * 882;
      const { l, r } = render(core, frames);
      const i16 = new Int16Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        i16[2 * i] = (l[i] ?? 0) * 32768;
        i16[2 * i + 1] = (r[i] ?? 0) * 32768;
        expect(Number.isInteger((l[i] ?? 0) * 32768)).toBe(true);
      }
      expect(fnv(new Uint8Array(i16.buffer))).toBe(want);
      prev = upto;
    }
  });

  it('is silent until played and after pause, without advancing', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    expect(render(core, 4410).l.every((s) => s === 0)).toBe(true);
    core.handle({ type: 'play' });
    expect(render(core, 8820).l.some((s) => s !== 0)).toBe(true);
    core.handle({ type: 'pause' });
    expect(render(core, 4410).l.every((s) => s === 0)).toBe(true);
    const positions = events.filter((e) => e.type === 'position');
    expect(positions.length).toBeGreaterThan(0);
  });

  it('reports the song on load and rejects garbage without throwing', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    const loaded = events.find((e) => e.type === 'song-loaded');
    expect(loaded).toMatchObject({
      id: nextId - 1,
      info: { channels: 4, droppedChannels: 0, sampleRate: SAMPLE_RATE },
    });

    core.handle({ type: 'load-song', id: nextId++, bytes: new Uint8Array([1, 2, 3, 4]) });
    const error = events.filter((e) => e.type === 'error').at(-1);
    expect(error).toMatchObject({ type: 'error', id: nextId - 1 });
    // A failed load leaves nothing playing.
    core.handle({ type: 'play' });
    expect(render(core, 1024).l.every((s) => s === 0)).toBe(true);
  });

  it('plays a 7-channel HVL at its native channel count', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('drainage_proble.hvl') });
    expect(events.find((e) => e.type === 'song-loaded')).toMatchObject({
      info: { channels: 7, droppedChannels: 0 },
    });
  });

  it('applies gain and restarts paused at the top of the song', () => {
    const a = newCore();
    const b = newCore();
    for (const { core } of [a, b]) {
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    }
    b.core.handle({ type: 'set-gain', gain: 0.5 });
    a.core.handle({ type: 'play' });
    b.core.handle({ type: 'play' });
    const la = render(a.core, 8820).l;
    const lb = render(b.core, 8820).l;
    expect(la.every((s, i) => lb[i] === s * 0.5)).toBe(true);

    a.core.handle({ type: 'restart' });
    expect(render(a.core, 1024).l.every((s) => s === 0)).toBe(true);
    a.core.handle({ type: 'play' });
    expect(render(a.core, 8820).l).toEqual(la);
  });

  it('reports song end once, when sunspots loops', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
    core.handle({ type: 'play' });
    // Its golden reaches song end within 3000 DecodeFrames (60 s).
    render(core, 882 * 3000);
    expect(events.filter((e) => e.type === 'song-end')).toHaveLength(1);
  });

  describe('stop at end', () => {
    // sunspots reaches song end inside its first 3000 DecodeFrames (60 s).
    const FRAME = 882;

    /** Renders quantum by quantum until `song-end` is posted; returns the left channel so far. */
    function renderToSongEnd(core: AhxProcessorCore, events: AhxEvent[]) {
      const ends = () => events.filter((e) => e.type === 'song-end').length;
      const before = ends();
      const chunks: Float32Array[] = [];
      while (ends() === before && chunks.length * QUANTUM < FRAME * 3500) {
        const l = new Float32Array(QUANTUM);
        core.process(l, new Float32Array(QUANTUM));
        chunks.push(l);
      }
      const left = new Float32Array(chunks.length * QUANTUM);
      chunks.forEach((c, i) => left.set(c, i * QUANTUM));
      return { frames: left.length, left };
    }

    it('pauses itself in the quantum that reaches the end, and renders silence after', () => {
      const { core, events } = newCore();
      core.handle({ type: 'set-stop-at-end', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      core.handle({ type: 'play' });

      const { frames } = renderToSongEnd(core, events);
      expect(events.filter((e) => e.type === 'song-end')).toHaveLength(1);
      expect(frames).toBeLessThan(FRAME * 3500);

      // Nothing more is played: the worklet did not loop into the intro
      // while a message made its way to the main thread and back.
      const after = render(core, FRAME * 10);
      expect(after.l.every((s) => s === 0)).toBe(true);
      expect(after.r.every((s) => s === 0)).toBe(true);
      // And no more position reports either.
      const positions = events.filter((e) => e.type === 'position').length;
      render(core, FRAME * 10);
      expect(events.filter((e) => e.type === 'position')).toHaveLength(positions);
    });

    it('is bit-identical to a looping run up to the ending quantum, then fades that quantum out', () => {
      const looping = newCore();
      looping.core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      looping.core.handle({ type: 'play' });
      const stopping = newCore();
      stopping.core.handle({ type: 'set-stop-at-end', enabled: true });
      stopping.core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      stopping.core.handle({ type: 'play' });

      const { frames, left } = renderToSongEnd(stopping.core, stopping.events);
      const reference = render(looping.core, frames).l;
      // Everything before the ending quantum is what the looping player made.
      const upto = frames - QUANTUM;
      expect(left.subarray(0, upto)).toEqual(reference.subarray(0, upto));
      // The ending quantum's last sample is faded to silence.
      expect(Math.abs(left[frames - 1] ?? 1)).toBe(0);
    });

    it('keeps looping (and reports once) when stop-at-end is off, or switched off again', () => {
      const { core, events } = newCore();
      core.handle({ type: 'set-stop-at-end', enabled: true });
      core.handle({ type: 'set-stop-at-end', enabled: false });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      core.handle({ type: 'play' });
      renderToSongEnd(core, events);
      const after = render(core, FRAME * 20);
      expect(after.l.some((s) => s !== 0)).toBe(true);
    });

    it('a restart afterwards plays the song again and can end again', () => {
      const { core, events } = newCore();
      core.handle({ type: 'set-stop-at-end', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      core.handle({ type: 'play' });
      renderToSongEnd(core, events);
      core.handle({ type: 'restart' });
      core.handle({ type: 'play' });
      expect(render(core, FRAME * 20).l.some((s) => s !== 0)).toBe(true);
      renderToSongEnd(core, events);
      expect(events.filter((e) => e.type === 'song-end')).toHaveLength(2);
    });
  });

  it('averages to mono when the output has one channel', () => {
    const stereo = newCore();
    const mono = newCore();
    for (const { core } of [stereo, mono]) {
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
      core.handle({ type: 'play' });
    }
    const { l, r } = render(stereo.core, 4410);
    const m = new Float32Array(4410);
    for (let at = 0; at < 4410; at += QUANTUM) {
      mono.core.process(m.subarray(at, Math.min(at + QUANTUM, 4410)));
    }
    for (let i = 0; i < 4410; i++) {
      expect(m[i]).toBeCloseTo(((l[i] ?? 0) + (r[i] ?? 0)) * 0.5, 7);
    }
  });
});

describe('AhxProcessorCore load ids and dispose', () => {
  it('answers each load with its own id and ignores a stale one', () => {
    const { core, events } = newCore();
    const first = nextId++;
    const second = nextId++;
    core.handle({ type: 'load-song', id: second, bytes: fixture('karma.ahx') });
    // Older than one already handled: dropped, not loaded over the newer song.
    core.handle({ type: 'load-song', id: first, bytes: fixture('sunspots.hvl') });
    const loaded = events.filter((e) => e.type === 'song-loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: second, info: { name: 'Karma' } });
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });

  it('is terminal after dispose: no commands, silence, and disposed is set', () => {
    const { core, events } = newCore();
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    core.handle({ type: 'play' });
    expect(core.disposed).toBe(false);
    core.handle({ type: 'dispose' });
    expect(core.disposed).toBe(true);
    const before = events.length;
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
    core.handle({ type: 'play' });
    expect(events).toHaveLength(before);
    expect(render(core, 1024).l.every((s) => s === 0)).toBe(true);
  });
});

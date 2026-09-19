// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  AHX_SCOPE_FULL_SCALE,
  AHX_SCOPE_POINTS,
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

    it('ends on the same quantum, with the same audio, with capture on', () => {
      const plain = newCore();
      const captured = newCore();
      for (const { core } of [plain, captured]) {
        core.handle({ type: 'set-stop-at-end', enabled: true });
        core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
        core.handle({ type: 'play' });
      }
      captured.core.handle({ type: 'set-capture', enabled: true });

      const a = renderToSongEnd(plain.core, plain.events);
      const b = renderToSongEnd(captured.core, captured.events);
      expect(b.frames).toBe(a.frames);
      expect(b.left).toEqual(a.left);
      expect(captured.events.filter((e) => e.type === 'waveforms').length).toBeGreaterThan(0);

      // Paused for good: silence, and no more reports of any kind.
      const seen = captured.events.length;
      const after = render(captured.core, FRAME * 10);
      expect(after.l.every((s) => s === 0)).toBe(true);
      expect(captured.events).toHaveLength(seen);
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

  describe('per-voice capture', () => {
    type Waveforms = Extract<AhxEvent, { type: 'waveforms' }>;
    const waveforms = (events: AhxEvent[]) =>
      events.filter((e): e is Waveforms => e.type === 'waveforms');

    /** As `newCore`, but copies each waveforms payload: the core refills one buffer in place. */
    function capturingCore() {
      const events: AhxEvent[] = [];
      const core = new AhxProcessorCore(
        AhxPlayer as unknown as AhxWasmPlayerCtor,
        SAMPLE_RATE,
        (e) => events.push(e.type === 'waveforms' ? { ...e, data: e.data.slice() } : e),
      );
      return { core, events };
    }

    it('is off by default: no waveforms events', () => {
      const { core, events } = newCore();
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE * 2);
      expect(events.filter((e) => e.type === 'position').length).toBeGreaterThan(0);
      expect(waveforms(events)).toHaveLength(0);
    });

    it('posts every voice at about 25 Hz, non-silent, within full scale', () => {
      const { core, events } = capturingCore();
      core.handle({ type: 'set-capture', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE * 2);

      const posted = waveforms(events);
      // One per ~40 ms interval (quantised up to whole 128-frame quanta).
      expect(posted.length).toBeGreaterThanOrEqual(40);
      expect(posted.length).toBeLessThanOrEqual(60);
      const last = posted.at(-1) as Waveforms;
      expect(last).toMatchObject({ channels: 4, points: AHX_SCOPE_POINTS });
      expect(last.data).toHaveLength(4 * AHX_SCOPE_POINTS);

      const soundingVoices = new Set<number>();
      for (const w of posted) {
        for (let v = 0; v < w.channels; v++) {
          const run = w.data.subarray(v * w.points, (v + 1) * w.points);
          if (run.some((x) => x !== 0)) soundingVoices.add(v);
        }
        expect(w.data.every((x) => Math.abs(x) <= AHX_SCOPE_FULL_SCALE)).toBe(true);
      }
      // karma plays more than one voice in its first two seconds.
      expect(soundingVoices.size).toBeGreaterThanOrEqual(2);
    });

    it('reports an HVL at its native channel count', () => {
      const { core, events } = capturingCore();
      core.handle({ type: 'set-capture', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('drainage_proble.hvl') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE);
      const last = waveforms(events).at(-1) as Waveforms;
      expect(last.channels).toBe(7);
      expect(last.data).toHaveLength(7 * AHX_SCOPE_POINTS);
    });

    it('never changes the rendered audio, whether on from the start or toggled mid-song', () => {
      const song = fixture('sunspots.hvl');
      const plain = newCore();
      const on = capturingCore();
      const toggled = capturingCore();
      for (const { core } of [plain, on, toggled]) {
        core.handle({ type: 'load-song', id: nextId++, bytes: song });
        core.handle({ type: 'play' });
      }
      on.core.handle({ type: 'set-capture', enabled: true });

      const frames = SAMPLE_RATE * 3;
      const ref = render(plain.core, frames);
      const withCapture = render(on.core, frames);
      expect(withCapture.l).toEqual(ref.l);
      expect(withCapture.r).toEqual(ref.r);

      // On for the middle second only.
      const parts = [SAMPLE_RATE, SAMPLE_RATE, SAMPLE_RATE].map((n, i) => {
        toggled.core.handle({ type: 'set-capture', enabled: i === 1 });
        return render(toggled.core, n);
      });
      const l = new Float32Array(frames);
      parts.forEach((p, i) => l.set(p.l, i * SAMPLE_RATE));
      expect(l).toEqual(ref.l);
      expect(waveforms(on.events).length).toBeGreaterThan(0);
      expect(waveforms(toggled.events).length).toBeGreaterThan(0);
    });

    it('stops reporting when switched off, and survives a reload while on', () => {
      const { core, events } = capturingCore();
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
      core.handle({ type: 'play' });
      core.handle({ type: 'set-capture', enabled: true });
      render(core, SAMPLE_RATE);
      expect(waveforms(events).length).toBeGreaterThan(0);

      core.handle({ type: 'set-capture', enabled: false });
      const n = waveforms(events).length;
      render(core, SAMPLE_RATE);
      expect(waveforms(events)).toHaveLength(n);

      // The flag outlives the song: a new load picks it up.
      core.handle({ type: 'set-capture', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('drainage_proble.hvl') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE);
      expect(waveforms(events).at(-1)?.channels).toBe(7);
    });

    it('a pause reports nothing more; a restart begins from a clean window', () => {
      const { core, events } = capturingCore();
      core.handle({ type: 'set-capture', enabled: true });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('karma.ahx') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE);
      core.handle({ type: 'pause' });
      const n = waveforms(events).length;
      render(core, SAMPLE_RATE);
      expect(waveforms(events)).toHaveLength(n);

      core.handle({ type: 'restart' });
      core.handle({ type: 'play' });
      render(core, QUANTUM * 15); // just past the first interval
      const first = waveforms(events)[n] as Waveforms;
      expect(first).toBeDefined();
      // The first report lands 14 quanta (1792 frames) in, so the oldest 256
      // of the window's 2048 frames (32 points) predate the restart: the
      // rewound engine cleared them, whatever was playing when it paused.
      for (let v = 0; v < first.channels; v++) {
        const head = first.data.subarray(v * first.points, v * first.points + 16);
        expect(Array.from(head)).toEqual(new Array(16).fill(0));
      }
    });
  });

  describe('per-voice mute and solo', () => {
    type Waveforms = Extract<AhxEvent, { type: 'waveforms' }>;
    const waveforms = (events: AhxEvent[]) =>
      events.filter((e): e is Waveforms => e.type === 'waveforms');
    const peak = (w: Waveforms, voice: number) =>
      w.data.subarray(voice * w.points, (voice + 1) * w.points).reduce((m, x) => Math.max(m, Math.abs(x)), 0);

    function started(setup?: (core: AhxProcessorCore) => void, song = 'karma.ahx') {
      const events: AhxEvent[] = [];
      const core = new AhxProcessorCore(
        AhxPlayer as unknown as AhxWasmPlayerCtor,
        SAMPLE_RATE,
        (e) => events.push(e.type === 'waveforms' ? { ...e, data: e.data.slice() } : e),
      );
      setup?.(core);
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture(song) });
      core.handle({ type: 'play' });
      return { core, events };
    }

    it('nothing set renders exactly like a core that never heard of it', () => {
      const plain = started();
      const cleared = started((core) => {
        core.handle({ type: 'set-mute-solo', mute: 0b1111, solo: 0b0001 });
        core.handle({ type: 'set-mute-solo', mute: 0, solo: 0 });
      });
      const a = render(plain.core, SAMPLE_RATE * 2);
      const b = render(cleared.core, SAMPLE_RATE * 2);
      expect(b.l).toEqual(a.l);
      expect(b.r).toEqual(a.r);
    });

    it('mute-all is digital silence, live, and un-muting brings the song back in step', () => {
      const plain = started();
      const { core } = started();
      const ref = render(plain.core, SAMPLE_RATE * 3);

      const first = render(core, SAMPLE_RATE);
      core.handle({ type: 'set-mute-solo', mute: 0b1111, solo: 0 });
      const silent = render(core, SAMPLE_RATE);
      core.handle({ type: 'set-mute-solo', mute: 0, solo: 0 });
      const last = render(core, SAMPLE_RATE);

      expect(first.l).toEqual(ref.l.subarray(0, SAMPLE_RATE));
      expect(silent.l.every((x) => x === 0) && silent.r.every((x) => x === 0)).toBe(true);
      expect(last.l).toEqual(ref.l.subarray(SAMPLE_RATE * 2));
    });

    it('is remembered across a load, like capture', () => {
      const { core } = started((c) => c.handle({ type: 'set-mute-solo', mute: 0xffff, solo: 0 }));
      expect(render(core, SAMPLE_RATE).l.every((x) => x === 0)).toBe(true);
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      core.handle({ type: 'play' });
      const after = render(core, SAMPLE_RATE);
      expect(after.l.every((x) => x === 0)).toBe(true);
      // The HVL's voices past the fourth are covered too.
      core.handle({ type: 'set-mute-solo', mute: 0, solo: 0 });
      expect(render(core, SAMPLE_RATE).l.some((x) => x !== 0)).toBe(true);
    });

    it('a muted voice flattens in the scope report while the others keep playing', () => {
      const { core, events } = started((c) => c.handle({ type: 'set-capture', enabled: true }));
      render(core, SAMPLE_RATE);
      const heard = waveforms(events).at(-1) as Waveforms;
      const audible = [...Array(heard.channels).keys()].filter((v) => peak(heard, v) > 0);
      expect(audible.length).toBeGreaterThanOrEqual(2);

      const [victim, other] = audible as [number, number];
      core.handle({ type: 'set-mute-solo', mute: 1 << victim, solo: 0 });
      // A whole capture window later nothing of the old signal is left in it.
      render(core, SAMPLE_RATE);
      const after = waveforms(events).at(-1) as Waveforms;
      expect(peak(after, victim)).toBe(0);
      expect(audible.filter((v) => v !== victim).some((v) => peak(after, v) > 0)).toBe(true);
      expect(other).not.toBe(victim);
    });

    it('solo leaves only that voice in the scope report', () => {
      const { core, events } = started((c) => c.handle({ type: 'set-capture', enabled: true }));
      render(core, SAMPLE_RATE);
      const heard = waveforms(events).at(-1) as Waveforms;
      const solo = [...Array(heard.channels).keys()].find((v) => peak(heard, v) > 0) as number;
      core.handle({ type: 'set-mute-solo', mute: 0, solo: 1 << solo });
      render(core, SAMPLE_RATE * 2);
      const after = waveforms(events).at(-1) as Waveforms;
      for (let v = 0; v < after.channels; v++) {
        if (v !== solo) expect(peak(after, v)).toBe(0);
      }
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

describe('hi-fi AHX rendering over the real wasm', () => {
  const started = (song: string, setup?: (core: AhxProcessorCore) => void) => {
    const { core } = newCore();
    setup?.(core);
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture(song) });
    core.handle({ type: 'play' });
    return core;
  };
  const second = SAMPLE_RATE * 2;

  it('off is the reference: never set, set to false, or set and cleared render the same bytes', () => {
    const plain = render(started('robocop_iii_j_tel.ahx'), second);
    const off = render(
      started('robocop_iii_j_tel.ahx', (c) => c.handle({ type: 'set-hifi', enabled: false })),
      second,
    );
    const cleared = render(
      started('robocop_iii_j_tel.ahx', (c) => {
        c.handle({ type: 'set-hifi', enabled: true });
        c.handle({ type: 'set-hifi', enabled: false });
      }),
      second,
    );
    expect(off.l).toEqual(plain.l);
    expect(cleared.l).toEqual(plain.l);
    expect(cleared.r).toEqual(plain.r);
  });

  it('on changes the sound, stays in range and in time, and is remembered across a load', () => {
    const plain = render(started('robocop_iii_j_tel.ahx'), second);
    const core = started('robocop_iii_j_tel.ahx', (c) => c.handle({ type: 'set-hifi', enabled: true }));
    const hifi = render(core, second);
    expect(hifi.l).not.toEqual(plain.l);
    expect(hifi.l.some((x) => x !== 0)).toBe(true);
    expect(hifi.l.every((x) => Math.abs(x) <= 1)).toBe(true);
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);
    expect(Math.abs(20 * Math.log10(rms(hifi.l) / rms(plain.l)))).toBeLessThan(2);

    // A second load starts with the last state set: same output as before.
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('robocop_iii_j_tel.ahx') });
    core.handle({ type: 'play' });
    expect(render(core, second).l).toEqual(hifi.l);

    // ... and switching it off puts the reference back.
    core.handle({ type: 'set-hifi', enabled: false });
    core.handle({ type: 'load-song', id: nextId++, bytes: fixture('robocop_iii_j_tel.ahx') });
    core.handle({ type: 'play' });
    expect(render(core, second).l).toEqual(plain.l);
  });

  describe('prewarm', () => {
    /** A core plus a way to ask it for its hi-fi stats. */
    function coreWithStats() {
      const events: AhxEvent[] = [];
      const core = new AhxProcessorCore(
        AhxPlayer as unknown as AhxWasmPlayerCtor,
        SAMPLE_RATE,
        (e) => events.push(e),
      );
      const ask = () => {
        core.handle({ type: 'get-hifi-stats' });
        const e = events.filter((x) => x.type === 'hifi-stats').at(-1);
        if (e?.type !== 'hifi-stats') throw new Error('no hifi-stats event');
        return e;
      };
      return { core, ask };
    }

    it('has the tables built and the render path locked by the time the song is loaded', () => {
      const { core, ask } = coreWithStats();
      core.handle({ type: 'set-hifi', enabled: true });
      // No song yet: nothing to prewarm.
      expect(ask()).toMatchObject({ enabled: false, locked: false, tables: 0 });
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('robocop_iii_j_tel.ahx') });
      const loaded = ask();
      expect(loaded).toMatchObject({ enabled: true, locked: true, misses: 0 });
      expect(loaded.tables).toBeGreaterThan(0);

      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE * 20);
      // Twenty seconds of playing built nothing and degraded nothing.
      expect(ask()).toEqual(loaded);
    });

    it('prewarms when hi-fi is switched on mid-song, and drops the bank when it is switched off', () => {
      const { core, ask } = coreWithStats();
      core.handle({ type: 'load-song', id: nextId++, bytes: fixture('sunspots.hvl') });
      core.handle({ type: 'play' });
      render(core, SAMPLE_RATE);
      expect(ask()).toMatchObject({ enabled: false, tables: 0 });

      core.handle({ type: 'set-hifi', enabled: true });
      const on = ask();
      expect(on).toMatchObject({ enabled: true, locked: true, misses: 0 });
      expect(on.tables).toBeGreaterThan(0);
      render(core, SAMPLE_RATE * 10);
      expect(ask()).toEqual(on);

      core.handle({ type: 'set-hifi', enabled: false });
      expect(ask()).toMatchObject({ enabled: false, locked: false, tables: 0 });
    });
  });
});

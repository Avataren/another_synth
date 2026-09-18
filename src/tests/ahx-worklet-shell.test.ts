// @vitest-environment node
//
// The AudioWorkletProcessor shell (`ahx-worklet.ts`): handshake, message
// routing, `process()`, disposal. `ahx-worklet-core.test.ts` covers the core
// behind it; this loads the *built* `public/worklets/ahx-worklet.js` -- the file
// the browser actually runs, glue and polyfills included -- into a bare
// `vm` context that provides only what an AudioWorkletGlobalScope does
// (`registerProcessor`, `sampleRate`, `currentTime`, `AudioWorkletProcessor`
// with a `port`), and drives it the way the audio thread and the main thread
// would. It needs `npm run build:worklets` to have produced the bundle (it is
// committed, so a checkout has it).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
const QUANTUM = 128;

const bundle = readFileSync(resolve(ROOT, 'public/worklets/ahx-worklet.js'), 'utf8');
// The bundle is ESM and the glue's default-init fallback names
// `import.meta.url`, which is a syntax error in a plain script. That branch is
// dead here (the shell always calls `initSync`), so give it a literal.
const script = new Script(bundle.replace('import.meta.url', '"file:///ahx-worklet.js"'), {
  filename: 'ahx-worklet.js',
});
const wasmBytes = () =>
  new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm')));
const fixture = (name: string) =>
  new Uint8Array(readFileSync(resolve(ROOT, 'public/demos/ahx', name)));

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type PostedEvent = { type: string; [key: string]: unknown };

/** A fresh AudioWorkletGlobalScope with the bundle evaluated in it. */
function loadShell() {
  const posted: PostedEvent[] = [];
  const registered: Array<{ name: string; ctor: new () => Processor }> = [];
  class AudioWorkletProcessor {
    port: FakePort = {
      onmessage: null,
      postMessage: (message) => posted.push(message as PostedEvent),
    };
  }
  // Deliberately no TextDecoder/TextEncoder/URL/fetch: the real scope has
  // none, and the bundle's own polyfill has to stand in for them.
  const scope = createContext({
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: new () => Processor) =>
      registered.push({ name, ctor }),
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    currentFrame: 0,
    console,
  });
  script.runInContext(scope);
  return { posted, registered };
}

/** Loads the shell and constructs its one processor, as the browser would. */
function newProcessor() {
  const { posted, registered } = loadShell();
  const [entry] = registered;
  const processor = new (entry as { ctor: new () => Processor }).ctor();
  const send = (data: unknown) => processor.port.onmessage?.({ data });
  const handshake = () => {
    send({ type: 'wasm-binary', wasmBytes: wasmBytes().buffer });
  };
  const ofType = (type: string) => posted.filter((e) => e.type === type);
  return { processor, posted, send, handshake, ofType };
}

/** Runs `quanta` render quanta of stereo output and returns the planar result. */
function run(processor: Processor, quanta: number) {
  const l = new Float32Array(quanta * QUANTUM);
  const r = new Float32Array(quanta * QUANTUM);
  for (let q = 0; q < quanta; q++) {
    const at = q * QUANTUM;
    const keep = processor.process(
      [],
      [[l.subarray(at, at + QUANTUM), r.subarray(at, at + QUANTUM)]],
    );
    expect(keep).toBe(true);
  }
  return { l, r };
}

/** FNV-1a-64, the hash the Rust goldens use. */
function fnv(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}

function firstGoldenChunk(name: string): [number, bigint] {
  const text = readFileSync(resolve(ROOT, 'rust-wasm/tests/golden', name), 'utf8');
  const m = /^(\d+) ([0-9a-f]{16})$/m.exec(text);
  return [Number((m as RegExpExecArray)[1]), BigInt('0x' + (m as RegExpExecArray)[2])];
}

describe('ahx-worklet.js in an AudioWorkletGlobalScope shim', () => {
  it('registers exactly one processor under the name the client asks for, and posts ready', () => {
    const { registered, posted } = loadShell();
    expect(registered.map((r) => r.name)).toEqual(['ahx-audio-processor']);
    expect(posted).toEqual([]);
    new (registered[0] as { ctor: new () => Processor }).ctor();
    expect(posted).toEqual([{ type: 'ready' }]);
  });

  it('answers a command that arrives before the wasm with an error, not a throw', () => {
    const { send, ofType } = newProcessor();
    expect(() => send({ type: 'play' })).not.toThrow();
    expect(ofType('error')).toEqual([
      { type: 'error', message: expect.stringMatching(/before the wasm was ready/) },
    ]);
  });

  it('renders silence, and keeps the node alive, until a song plays', () => {
    const { processor } = newProcessor();
    // Pre-filled so a shell that forgot to clear its output would show.
    const l = new Float32Array(QUANTUM).fill(1);
    const r = new Float32Array(QUANTUM).fill(1);
    expect(processor.process([], [[l, r]])).toBe(true);
    expect(l.every((s) => s === 0) && r.every((s) => s === 0)).toBe(true);
    // A mono output (no second channel), and a bus with no channels at all.
    const mono = new Float32Array(QUANTUM).fill(1);
    expect(processor.process([], [[mono]])).toBe(true);
    expect(mono.every((s) => s === 0)).toBe(true);
    expect(processor.process([], [[]])).toBe(true);
    expect(processor.process([], [])).toBe(true);
  });

  it('runs the wasm handshake once: wasm-ready, and a second binary is ignored', () => {
    const { handshake, ofType } = newProcessor();
    handshake();
    expect(ofType('wasm-ready')).toHaveLength(1);
    handshake();
    expect(ofType('wasm-ready')).toHaveLength(1);
    expect(ofType('error')).toEqual([]);
  });

  it('reports a wasm that will not instantiate instead of throwing', () => {
    const { send, ofType } = newProcessor();
    expect(() =>
      send({ type: 'wasm-binary', wasmBytes: new Uint8Array([0, 1, 2, 3]).buffer }),
    ).not.toThrow();
    expect(ofType('error')).toEqual([
      { type: 'error', message: expect.stringMatching(/AHX wasm init failed/) },
    ]);
    expect(ofType('wasm-ready')).toEqual([]);
    // Still not ready afterwards: commands keep getting the not-ready error.
    send({ type: 'play' });
    expect(ofType('error')).toHaveLength(2);
  });

  it('routes load-song / play through to audio, bit-exact with the C reference', () => {
    const { processor, send, handshake, ofType } = newProcessor();
    handshake();
    send({ type: 'load-song', id: 7, bytes: fixture('karma.ahx') });
    expect(ofType('song-loaded')).toMatchObject([
      { id: 7, info: { name: 'Karma', channels: 4, droppedChannels: 0, sampleRate: SAMPLE_RATE } },
    ]);

    // Loaded but not playing: still silent.
    expect(run(processor, 4).l.every((s) => s === 0)).toBe(true);

    send({ type: 'play' });
    // The first golden chunk is 50 DecodeFrames = 1 s = 44100 samples; render a
    // whole number of quanta past it and hash exactly the first second.
    const [frames, want] = firstGoldenChunk('karma.44100.s2.cap0.txt');
    const samples = frames * 882;
    const { l, r } = run(processor, Math.ceil(samples / QUANTUM));
    const i16 = new Int16Array(samples * 2);
    for (let i = 0; i < samples; i++) {
      i16[2 * i] = (l[i] ?? 0) * 32768;
      i16[2 * i + 1] = (r[i] ?? 0) * 32768;
    }
    expect(fnv(new Uint8Array(i16.buffer))).toBe(want);
    expect(ofType('position').length).toBeGreaterThan(0);
  });

  it('downmixes to a mono output bus', () => {
    const { processor, send, handshake } = newProcessor();
    handshake();
    send({ type: 'load-song', id: 0, bytes: fixture('karma.ahx') });
    send({ type: 'play' });
    let audible = false;
    for (let q = 0; q < 400; q++) {
      const mono = new Float32Array(QUANTUM);
      expect(processor.process([], [[mono]])).toBe(true);
      if (mono.some((s) => s !== 0)) audible = true;
    }
    expect(audible).toBe(true);
  });

  it('answers a load of garbage with an error carrying the load id, and stays usable', () => {
    const { processor, send, handshake, ofType } = newProcessor();
    handshake();
    send({ type: 'load-song', id: 3, bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(ofType('error')).toMatchObject([{ id: 3 }]);
    send({ type: 'load-song', id: 4, bytes: fixture('karma.ahx') });
    expect(ofType('song-loaded')).toMatchObject([{ id: 4 }]);
    send({ type: 'play' });
    expect(processor.process([], [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]])).toBe(
      true,
    );
  });

  it('pause silences it and restart rewinds it paused', () => {
    const { processor, send, handshake } = newProcessor();
    handshake();
    send({ type: 'load-song', id: 0, bytes: fixture('karma.ahx') });
    send({ type: 'play' });
    expect(run(processor, 200).l.some((s) => s !== 0)).toBe(true);
    send({ type: 'pause' });
    expect(run(processor, 8).l.every((s) => s === 0)).toBe(true);
    send({ type: 'play' });
    send({ type: 'restart', subsong: 0 });
    expect(run(processor, 8).l.every((s) => s === 0)).toBe(true);
  });

  it('stops being processed after dispose, and ignores later commands', () => {
    const { processor, posted, send, handshake } = newProcessor();
    handshake();
    send({ type: 'load-song', id: 0, bytes: fixture('karma.ahx') });
    send({ type: 'play' });
    run(processor, 4);
    send({ type: 'dispose' });
    // false is what lets the browser garbage-collect the node.
    expect(processor.process([], [[new Float32Array(QUANTUM), new Float32Array(QUANTUM)]])).toBe(
      false,
    );
    const before = posted.length;
    send({ type: 'load-song', id: 1, bytes: fixture('karma.ahx') });
    send({ type: 'play' });
    expect(posted).toHaveLength(before);
    expect(processor.process([], [[new Float32Array(QUANTUM)]])).toBe(false);
  });
});

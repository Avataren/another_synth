// @vitest-environment node
//
// The AudioWorkletProcessor shell (`opl-worklet.ts`): handshake, message
// routing, `process()`, disposal. `opl-worklet-core.test.ts` covers the core
// behind it; this loads the *built* `public/worklets/opl-worklet.js` into a
// bare `vm` context that provides only what an AudioWorkletGlobalScope does,
// as `ahx-worklet-shell.test.ts` does for AHX. The OPL shell alone reads
// `currentFrame`, to put AudioContext-time writes on the renderer's clock,
// so the shim advances it per quantum as the audio thread does.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 48000;
const QUANTUM = 128;

const bundle = readFileSync(resolve(ROOT, 'public/worklets/opl-worklet.js'), 'utf8');
// See ahx-worklet-shell.test.ts: the glue's dead default-init branch names
// `import.meta.url`, a syntax error in a plain script.
const script = new Script(bundle.replace('import.meta.url', '"file:///opl-worklet.js"'), {
  filename: 'opl-worklet.js',
});
const wasmBytes = () => new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm')));

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
}

interface Processor {
  port: FakePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type PostedEvent = { type: string; [key: string]: unknown };

/** A fresh scope whose clock starts at `startFrame`, with one processor constructed. */
function newProcessor(startFrame = 0) {
  const posted: PostedEvent[] = [];
  const registered: Array<{ name: string; ctor: new () => Processor }> = [];
  class AudioWorkletProcessor {
    port: FakePort = {
      onmessage: null,
      postMessage: (message) => posted.push(message as PostedEvent),
    };
  }
  const scope = createContext({
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: new () => Processor) => registered.push({ name, ctor }),
    sampleRate: SAMPLE_RATE,
    currentTime: startFrame / SAMPLE_RATE,
    currentFrame: startFrame,
    console,
  }) as { currentFrame: number; currentTime: number };
  script.runInContext(scope);
  const [entry] = registered;
  const processor = new (entry as { ctor: new () => Processor }).ctor();
  const send = (data: unknown) => processor.port.onmessage?.({ data });
  const ofType = (type: string) => posted.filter((e) => e.type === type);

  /** Runs `quanta` stereo quanta, advancing the scope's clock like the audio thread. */
  const run = (quanta: number) => {
    const l = new Float32Array(quanta * QUANTUM);
    const r = new Float32Array(quanta * QUANTUM);
    for (let q = 0; q < quanta; q++) {
      const at = q * QUANTUM;
      expect(processor.process([], [[l.subarray(at, at + QUANTUM), r.subarray(at, at + QUANTUM)]])).toBe(true);
      scope.currentFrame += QUANTUM;
      scope.currentTime = scope.currentFrame / SAMPLE_RATE;
    }
    return { l, r };
  };
  return { registered, posted, processor, send, ofType, run };
}

/** Channel 0 held sine at ≈ 440 Hz, then key-on, as (time, reg, val) triples at `t`. */
function sineAt(t: number): Float64Array {
  const regs = [
    [0x20, 0x01], [0x23, 0x21], [0x40, 0x3f], [0x43, 0x00], [0x60, 0xf0],
    [0x63, 0xf0], [0x80, 0x00], [0x83, 0x0f], [0xa0, 0x44], [0xb0, 0x32],
  ];
  return new Float64Array(regs.flatMap(([reg, val]) => [t, reg as number, val as number]));
}

describe('opl-worklet.js in an AudioWorkletGlobalScope shim', () => {
  it('registers one processor and posts ready, then wasm-ready after the handshake', () => {
    const { registered, send, ofType } = newProcessor();
    expect(registered.map((r) => r.name)).toEqual(['opl-audio-processor']);
    expect(ofType('ready')).toHaveLength(1);
    send({ type: 'wasm-binary', wasmBytes: wasmBytes().buffer });
    expect(ofType('wasm-ready')).toHaveLength(1);
    expect(ofType('error')).toEqual([]);
  });

  it('answers a command before the wasm with an error, and renders silence meanwhile', () => {
    const { send, ofType, run } = newProcessor();
    expect(() => send({ type: 'panic' })).not.toThrow();
    expect(ofType('error')).toEqual([{ type: 'error', message: expect.stringMatching(/before the wasm was ready/) }]);
    expect(run(4).l.every((v) => v === 0)).toBe(true);
  });

  it('plays writes stamped in context seconds on the scope clock, started mid-context', () => {
    // Scope already 2 s in; the note is stamped for 2.05 s.
    const { send, run } = newProcessor(2 * SAMPLE_RATE);
    send({ type: 'wasm-binary', wasmBytes: wasmBytes().buffer });
    send({ type: 'writes', writes: sineAt(2.05) });
    const { l, r } = run(Math.ceil(SAMPLE_RATE / 5 / QUANTUM));
    const onset = l.findIndex((v) => Math.abs(v) > 1e-3);
    expect(onset).toBeGreaterThanOrEqual(0.05 * SAMPLE_RATE + 30);
    expect(onset).toBeLessThanOrEqual(0.05 * SAMPLE_RATE + 36);
    expect(Array.from(r)).toEqual(Array.from(l));
  });

  it('lets the node be collected after dispose', () => {
    const { send, processor } = newProcessor();
    send({ type: 'wasm-binary', wasmBytes: wasmBytes().buffer });
    send({ type: 'dispose' });
    const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
    expect(processor.process([], [out])).toBe(false);
  });
});

// The *built* `public/worklets/synth-worklet.js` -- the file the browser runs,
// wasm glue included -- evaluated in a bare `vm` context that provides only
// what an AudioWorkletGlobalScope does, plus the real
// `public/wasm/audio_processor_bg.wasm`. `createSynthWorkletNode` wraps the
// processor in the main-thread surface `PooledInstrument` and `WorkletPool`
// touch (`port`, `parameters`, `connect`), so a test can drive the production
// main-thread classes against the production worklet end to end.
//
// Messages are copied across the fake port the way the real one copies them:
// into the worklet's realm going in (wasm-bindgen glue rejects foreign-realm
// objects, e.g. "Expected parameter map object"), and through
// `structuredClone` coming out. Delivery is asynchronous in both directions
// (a macrotask per message, FIFO), as with a real port, so two requests in
// flight really do overlap; `settle()` drains the queue. `render()` runs one
// `process()` quantum with every AudioParam at its current value.
//
// Like `ahx-worklet-shell.test.ts`, this needs `npm run build:worklets` to have
// produced the bundle; `artifact-freshness.test.ts` fails if it is stale.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';

const ROOT = resolve(__dirname, '../../..');
export const SAMPLE_RATE = 44100;
export const QUANTUM = 128;

let cachedScript: Script | null = null;
function bundleScript(): Script {
  if (cachedScript) return cachedScript;
  const source = readFileSync(
    resolve(ROOT, 'public/worklets/synth-worklet.js'),
    'utf8',
  )
    // A module's trailing `export { ... }` is a syntax error in a script.
    .replace(/^export \{[\s\S]*?\};?\s*$/m, '')
    // The scope's `import.meta` has a `url` and nothing else, as in a real
    // AudioWorkletGlobalScope (so `import.meta.env.X` throws there too).
    .replace(/import\.meta/g, '({ url: "file:///synth-worklet.js" })');
  cachedScript = new Script(source, { filename: 'synth-worklet.js' });
  return cachedScript;
}

/**
 * Compiled inside the scope, so what they build belongs to the worklet's realm:
 * a deep copy for inbound messages, and the `process()` arguments.
 */
const IN_SCOPE_HELPERS = `({
  clone: function clone(value) {
    if (value === null || typeof value !== 'object') return value;
    const tag = Object.prototype.toString.call(value);
    if (tag === '[object ArrayBuffer]') {
      const out = new ArrayBuffer(value.byteLength);
      new Uint8Array(out).set(new Uint8Array(value));
      return out;
    }
    if (ArrayBuffer.isView(value)) {
      return new globalThis[value.constructor.name](value);
    }
    if (Array.isArray(value)) return value.map(clone);
    const out = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  },
  params(entries, frames) {
    const record = {};
    for (const [name, value] of entries) {
      record[name] = new Float32Array(frames).fill(value);
    }
    return record;
  },
  buffers(frames) {
    return [new Float32Array(frames), new Float32Array(frames)];
  },
})`;

let cachedWasm: Uint8Array | null = null;
function wasmBytes(): ArrayBuffer {
  if (!cachedWasm) {
    cachedWasm = new Uint8Array(
      readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm')),
    );
  }
  return cachedWasm.slice().buffer;
}

type Listener = (event: { data: unknown }) => void;
export type PostedEvent = { type: string; [key: string]: unknown };

interface ProcessorPort {
  onmessage: Listener | null;
  postMessage(message: unknown): void;
}

interface Processor {
  port: ProcessorPort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

interface ProcessorCtor {
  new (): Processor;
  parameterDescriptors: Array<{ name: string; defaultValue: number }>;
}

/** Enough of an AudioParam for PooledInstrument: every write lands now. */
class FakeAudioParam {
  constructor(public value: number) {}
  setValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  linearRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  exponentialRampToValueAtTime(value: number) {
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number) {
    this.value = value;
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  cancelAndHoldAtTime() {
    return this;
  }
}

export interface SynthWorkletHarness {
  /** Stands in for the AudioWorkletNode. */
  node: AudioWorkletNode;
  /** Every message the processor posted, in order. */
  posted: PostedEvent[];
  ofType(type: string): PostedEvent[];
  /** Resolves once every message posted so far (and their replies) landed. */
  settle(): Promise<void>;
  /** Runs one quantum; returns the left channel. */
  render(): Float32Array;
  /** The processor instance, for white-box assertions. */
  processor: unknown;
}

export function createSynthWorkletNode(): SynthWorkletHarness {
  const posted: PostedEvent[] = [];
  const listeners = new Set<Listener>();
  let inFlight = 0;
  const deliver = (task: () => void) => {
    inFlight += 1;
    setTimeout(() => {
      inFlight -= 1;
      task();
    }, 0);
  };
  const settle = async () => {
    while (inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const registered: ProcessorCtor[] = [];

  class AudioWorkletProcessor {
    port: ProcessorPort = {
      onmessage: null,
      postMessage: (message) => {
        const data = structuredClone(message) as PostedEvent;
        posted.push(data);
        deliver(() => {
          for (const listener of [...listeners]) listener({ data });
        });
      },
    };
  }

  const scope = createContext({
    AudioWorkletProcessor,
    registerProcessor: (_name: string, ctor: ProcessorCtor) =>
      registered.push(ctor),
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    currentFrame: 0,
    console: { ...console, log: () => {}, debug: () => {} },
  });
  bundleScript().runInContext(scope);
  const intoScope = new Script(IN_SCOPE_HELPERS).runInContext(scope) as {
    clone(value: unknown): unknown;
    params(
      entries: Array<[string, number]>,
      frames: number,
    ): Record<string, Float32Array>;
    buffers(frames: number): Float32Array[];
  };

  const ctor = registered[0];
  if (!ctor) throw new Error('synth-worklet.js registered no processor');
  const processor = new ctor();

  const parameters = new Map<string, FakeAudioParam>();
  for (const descriptor of ctor.parameterDescriptors) {
    parameters.set(descriptor.name, new FakeAudioParam(descriptor.defaultValue));
  }

  const port = {
    addEventListener: (_type: string, listener: Listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    postMessage: (message: unknown) => {
      const data = intoScope.clone(message);
      deliver(() => processor.port.onmessage?.({ data }));
    },
    start: () => {},
  };

  const node = {
    port,
    parameters,
    connect: () => {},
    disconnect: () => {},
  } as unknown as AudioWorkletNode;

  // The loader's handshake (`audio-processor-loader.ts`): hand over the wasm.
  port.postMessage({ type: 'wasm-binary', wasmBytes: wasmBytes() });

  const render = () => {
    const [left, right] = intoScope.buffers(QUANTUM) as [
      Float32Array,
      Float32Array,
    ];
    const record = intoScope.params(
      [...parameters].map(([name, param]) => [name, param.value]),
      QUANTUM,
    );
    processor.process([], [[left, right]], record);
    return Float32Array.from(left);
  };

  return {
    node,
    posted,
    ofType: (type) => posted.filter((event) => event.type === type),
    settle,
    render,
    processor,
  };
}

/** Enough of an AudioContext for PooledInstrument and WorkletPool. */
export function createFakeAudioContext(): AudioContext {
  return {
    sampleRate: SAMPLE_RATE,
    currentTime: 0,
    createGain: () => ({
      gain: new FakeAudioParam(1),
      connect: () => {},
      disconnect: () => {},
    }),
  } as unknown as AudioContext;
}

/** A mono 32-bit float WAV holding `samples`. */
export function floatWav(samples: Float32Array, rate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 4;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Float32Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}

export function rms(buffer: Float32Array): number {
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

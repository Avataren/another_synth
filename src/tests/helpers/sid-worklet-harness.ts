import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this harness is about the real bytes.
import { SidPlayer, initSync } from '../../../public/wasm/audio_processor.js';
import { resetPostFxRegistryForTests } from '@another-synth/tracker-playback';
import { SidProcessorCore, type SidCommand, type SidEvent, type SidWasmPlayerCtor } from 'src/audio/worklets/sid-core';

/**
 * The stand-in render thread for a SID song played through the app's real
 * chain (the pattern of `sid-playback-chain.test.ts`, S4): `AudioWorkletNode`
 * is a fake whose port runs the REAL `SidProcessorCore` over the REAL wasm in
 * `public/wasm`, and `pump(frames)` does what the worklet shell's `process`
 * does (output 0 = mix, outputs 1..3 = the voice taps) in 128-frame quanta.
 * Everything above it (tracker store, song host, playback store, SID
 * transport, player client) is the production code.
 */

const ROOT = resolve(__dirname, '../../..');
export const SID_HARNESS_SAMPLE_RATE = 44100;

let wasmReady = false;
/** Instantiates the real wasm once per test file. */
export function initSidWasm(): void {
  if (wasmReady) return;
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
  wasmReady = true;
}

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}

class FakeNode {
  readonly numberOfOutputs = 1;
  readonly gain = new FakeAudioParam();
  constructor(readonly context: unknown) {}
  connect(to: unknown): unknown {
    return to;
  }
  disconnect(): void {}
}

export const sidWorkletNodes: FakeSidWorkletNode[] = [];

/** `AudioWorkletNode` for 'sid-audio-processor': the real core behind a fake port. */
export class FakeSidWorkletNode extends FakeNode {
  readonly received: SidCommand[] = [];
  onprocessorerror: (() => void) | null = null;
  private core: SidProcessorCore | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly port: {
    postMessage: (message: unknown) => void;
    close: () => void;
    onmessage: ((event: MessageEvent) => void) | null;
  };

  constructor(context: unknown, name: string, readonly options: { numberOfOutputs: number; outputChannelCount: number[] }) {
    super(context);
    const node = this as FakeSidWorkletNode;
    this.port = {
      postMessage: (message: unknown) => node.fromMain(message),
      close: () => undefined,
      get onmessage() {
        return node.handler;
      },
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        node.handler = handler;
      },
    };
    expect(name).toBe('sid-audio-processor');
    sidWorkletNodes.push(this);
    setTimeout(() => this.toMain({ type: 'ready' }), 0);
  }

  private toMain(data: unknown): void {
    setTimeout(() => this.handler?.({ data } as MessageEvent), 0);
  }

  private fromMain(message: unknown): void {
    const data = message as { type: string };
    if (data.type === 'wasm-binary') {
      this.core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, SID_HARNESS_SAMPLE_RATE, (event: SidEvent) => this.toMain(event));
      this.toMain({ type: 'wasm-ready' });
      return;
    }
    this.received.push(message as SidCommand);
    this.core?.handle(message as SidCommand);
  }

  /** `frames` frames of what the worklet shell's `process` outputs: mix and the three voice taps. */
  pump(frames: number): { mix: Float32Array; taps: Float32Array[] } {
    const mix = new Float32Array(frames);
    const right = new Float32Array(frames);
    const taps = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
    for (let at = 0; at < frames; at += 128) {
      const n = Math.min(128, frames - at);
      this.core?.process(mix.subarray(at, at + n), right.subarray(at, at + n), taps.map((t) => t.subarray(at, at + n)));
    }
    return { mix, taps };
  }
}

class FakeAudioContextStub {
  sampleRate = SID_HARNESS_SAMPLE_RATE;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new FakeNode(this);
  addEventListener(): void {}
  removeEventListener(): void {}
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  createGain(): FakeNode {
    return new FakeNode(this);
  }
  createIIRFilter(): FakeNode {
    return new FakeNode(this);
  }
  createDynamicsCompressor(): object {
    return Object.assign(new FakeNode(this), {
      threshold: new FakeAudioParam(),
      knee: new FakeAudioParam(),
      ratio: new FakeAudioParam(),
      attack: new FakeAudioParam(),
      release: new FakeAudioParam(),
      reduction: 0,
    });
  }
  createWaveShaper(): object {
    return Object.assign(new FakeNode(this), { curve: null, oversample: 'none' });
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));
export async function until(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * A fresh app: pinia, the real tracker store, song host and playback store,
 * with the audio globals replaced by the stand-ins. Undo with `teardownSidApp`.
 */
export async function setupSidApp() {
  sidWorkletNodes.length = 0;
  localStorage.clear();
  resetPostFxRegistryForTests();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContextStub as unknown;
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeSidWorkletNode as unknown;
  const wasm = readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(String(url)).toMatch(/wasm\/audio_processor_bg\.wasm$/);
      return { ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) };
    }),
  );
  const { useTrackerStore } = await import('src/stores/tracker-store');
  const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
  const { useTrackerSongHost } = await import('src/composables/useTrackerSongHost');
  setActivePinia(createPinia());
  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const host = useTrackerSongHost();
  const playbackStore = useTrackerPlaybackStore();
  return { host, trackerStore, playbackStore };
}

export function teardownSidApp(): void {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
}

export const peak = (x: Float32Array): number => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

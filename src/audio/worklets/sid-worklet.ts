/// <reference lib="webworker" />

/**
 * AudioWorklet shell for the SID song player (`rust-wasm/src/sid/wasm.rs`,
 * plan-sid-tracking.md S4).
 *
 * A dedicated processor, like the AHX one: a SID song is a fixed three-voice
 * chip that runs its own sequencer in Rust. Handshake, same shape as the AHX
 * worklet's: post `ready`; the main thread answers with the wasm bytes
 * (`wasm-binary`); this posts `wasm-ready`. Everything after that is a
 * `SidCommand` / `SidEvent` (see `sid-core.ts`).
 *
 * Outputs: 0 the mix (stereo), 1..3 the voices' own signals (mono each).
 */
// First, and it must stay first: the wasm glue builds a TextDecoder at module
// load, and an AudioWorkletGlobalScope has none until this polyfills it.
import './textencoder.js';
import { SidPlayer, initSync } from 'app/public/wasm/audio_processor.js';
import { SidProcessorCore, type SidCommand, type SidWasmPlayerCtor } from './sid-core';

// Module-local, like ahx-worklet.ts: the synth worklet declares these
// globally with a different shape, and the two must not collide.
declare const sampleRate: number;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (): AudioWorkletProcessor;
};

declare const registerProcessor: (name: string, processorCtor: new () => AudioWorkletProcessor) => void;

class SidAudioProcessor extends AudioWorkletProcessor {
  private core: SidProcessorCore | null = null;
  private wasmReady = false;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent) => {
      const data = event.data as { type: string; wasmBytes?: ArrayBuffer };
      if (data.type === 'wasm-binary' && data.wasmBytes) {
        this.initWasm(data.wasmBytes);
        return;
      }
      if (!this.core) {
        this.port.postMessage({ type: 'error', message: 'SID worklet received a command before the wasm was ready' });
        return;
      }
      this.core.handle(data as SidCommand);
    };
    this.port.postMessage({ type: 'ready' });
  }

  private initWasm(wasmBytes: ArrayBuffer): void {
    if (this.wasmReady) return;
    try {
      initSync({ module: new Uint8Array(wasmBytes) });
      this.core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, sampleRate, (event) =>
        this.port.postMessage(event),
      );
      this.wasmReady = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (error) {
      this.port.postMessage({ type: 'error', message: `SID wasm init failed: ${String(error)}` });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Returning false lets the browser collect the node once the client has
    // disposed it; an input-less processor that returns true is never freed.
    if (this.core?.disposed) return false;
    const main = outputs[0];
    const mix = main?.[0];
    if (!mix) return true;
    const taps = [outputs[1]?.[0], outputs[2]?.[0], outputs[3]?.[0]];
    if (this.core) {
      this.core.process(mix, main[1], taps);
    } else {
      mix.fill(0);
      main[1]?.fill(0);
      for (const tap of taps) tap?.fill(0);
    }
    return true;
  }
}

registerProcessor('sid-audio-processor', SidAudioProcessor);

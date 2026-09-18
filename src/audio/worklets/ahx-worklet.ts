/// <reference lib="webworker" />

/**
 * AudioWorklet shell for the AHX/HVL engine (`rust-wasm/src/ahx/`).
 *
 * A dedicated processor, not another `AudioEngine` in the synth worklet: an
 * AHX song is a fixed four-voice engine that runs its own transport in Rust,
 * so it needs none of the synth worklet's AudioParam plumbing. Handshake, same
 * shape as the synth worklet's: post `ready`; the main thread answers with the
 * wasm bytes (`wasm-binary`); this posts `wasm-ready`. Everything after that is
 * an `AhxCommand` / `AhxEvent` (see `ahx-core.ts`).
 */
// First, and it must stay first: the wasm glue builds a TextDecoder at module
// load, and an AudioWorkletGlobalScope has none until this polyfills it.
import './textencoder.js';
import { AhxPlayer, initSync } from 'app/public/wasm/audio_processor.js';
import {
  AhxProcessorCore,
  type AhxCommand,
  type AhxWasmPlayerCtor,
} from './ahx-core';

// Module-local, like effects-worklet.ts: the synth worklet declares these
// globally with a different shape, and the two must not collide.
declare const sampleRate: number;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (): AudioWorkletProcessor;
};

declare const registerProcessor: (
  name: string,
  processorCtor: new () => AudioWorkletProcessor,
) => void;

class AhxAudioProcessor extends AudioWorkletProcessor {
  private core: AhxProcessorCore | null = null;
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
        this.port.postMessage({
          type: 'error',
          message: 'AHX worklet received a command before the wasm was ready',
        });
        return;
      }
      this.core.handle(data as AhxCommand);
    };
    this.port.postMessage({ type: 'ready' });
  }

  private initWasm(wasmBytes: ArrayBuffer): void {
    if (this.wasmReady) return;
    try {
      initSync({ module: new Uint8Array(wasmBytes) });
      this.core = new AhxProcessorCore(
        AhxPlayer as unknown as AhxWasmPlayerCtor,
        sampleRate,
        (event) => this.port.postMessage(event),
      );
      this.wasmReady = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (error) {
      this.port.postMessage({
        type: 'error',
        message: `AHX wasm init failed: ${String(error)}`,
      });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const channels = outputs[0];
    const left = channels?.[0];
    if (!left) return true;
    if (this.core) {
      this.core.process(left, channels[1]);
    } else {
      left.fill(0);
      channels[1]?.fill(0);
    }
    return true;
  }
}

registerProcessor('ahx-audio-processor', AhxAudioProcessor);

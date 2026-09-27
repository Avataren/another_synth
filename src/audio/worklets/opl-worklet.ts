/// <reference lib="webworker" />

/**
 * AudioWorklet shell for the OPL chip (`rust-wasm/src/opl/wasm.rs`,
 * .ai/plan-opl.md O2): a register-stream device that anything playing OPL
 * music (S3M AdLib channels, later A2M) writes to.
 *
 * Handshake, same shape as the SID and AHX worklets: post `ready`; the main
 * thread answers with the wasm bytes (`wasm-binary`); this posts
 * `wasm-ready`. Everything after that is an `OplCommand` / `OplEvent` (see
 * `opl-core.ts`).
 *
 * Output 0: stereo.
 */
// First, and it must stay first: the wasm glue builds a TextDecoder at module
// load, and an AudioWorkletGlobalScope has none until this polyfills it.
import './textencoder.js';
import { OplRenderer, initSync } from 'app/public/wasm/audio_processor.js';
import { OplProcessorCore, type OplCommand, type OplWasmRendererCtor } from './opl-core';

// Module-local, like sid-worklet.ts: the synth worklet declares these
// globally with a different shape, and the two must not collide.
declare const sampleRate: number;
declare const currentFrame: number;

interface AudioWorkletProcessor {
  readonly port: MessagePort;
}

declare const AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (): AudioWorkletProcessor;
};

declare const registerProcessor: (name: string, processorCtor: new () => AudioWorkletProcessor) => void;

class OplAudioProcessor extends AudioWorkletProcessor {
  private core: OplProcessorCore | null = null;
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
        this.port.postMessage({ type: 'error', message: 'OPL worklet received a command before the wasm was ready' });
        return;
      }
      this.core.handle(data as OplCommand);
    };
    this.port.postMessage({ type: 'ready' });
  }

  private initWasm(wasmBytes: ArrayBuffer): void {
    if (this.wasmReady) return;
    try {
      initSync({ module: new Uint8Array(wasmBytes) });
      this.core = new OplProcessorCore(OplRenderer as unknown as OplWasmRendererCtor, sampleRate, currentFrame, (event) =>
        this.port.postMessage(event),
      );
      this.wasmReady = true;
      this.port.postMessage({ type: 'wasm-ready' });
    } catch (error) {
      this.port.postMessage({ type: 'error', message: `OPL wasm init failed: ${String(error)}` });
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    // Returning false lets the browser collect the node once the client has
    // disposed it; an input-less processor that returns true is never freed.
    if (this.core?.disposed) return false;
    const main = outputs[0];
    const left = main?.[0];
    if (!left) return true;
    if (this.core) {
      this.core.process(left, main[1], currentFrame);
    } else {
      left.fill(0);
      main[1]?.fill(0);
    }
    return true;
  }
}

registerProcessor('opl-audio-processor', OplAudioProcessor);

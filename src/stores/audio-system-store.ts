// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import Instrument from 'src/audio/instrument';
import { loadWasmModule } from 'src/utils/wasm-loader';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}
const max_instruments = 64;
const max_voices = 8 * max_instruments;
export interface WasmMemoryPointers {
  audioBufferPtr: number;
  envelope1Ptr: number;
  parameterPtrs: {
    frequency: number;
    gain: number;
    detune: number;
    gate: number;
  };
  offsetsPtr: number;
}
export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
    currentInstrument: null as Instrument | null,
    wasmPointers: new Array<WasmMemoryPointers>(),
    voices_allocated: 0,
    wasmMemory: new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    }),
  }),
  getters: {
    parameterDescriptors(): AudioParamDescriptor[] {
      return [
        {
          name: 'frequency',
          defaultValue: 440,
          minValue: 20,
          maxValue: 20000,
          automationRate: 'a-rate',
        },
        {
          name: 'gain',
          defaultValue: 0.5,
          minValue: 0,
          maxValue: 1,
          automationRate: 'k-rate',
        },
        {
          name: 'detune',
          defaultValue: 0,
          minValue: -1200,
          maxValue: 1200,
          automationRate: 'k-rate',
        },
        {
          name: 'gate',
          defaultValue: 0,
          minValue: 0,
          maxValue: 1,
          automationRate: 'a-rate',
        },
      ];
    },
  },
  actions: {
    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = new AudioSystem();
      }
    },

    getNextMemorySegment() {
      const memSegment = this.wasmPointers[this.voices_allocated];
      this.voices_allocated++;
      return memSegment;
    },

    async setupAudio() {
      if (this.audioSystem) {
        const wasmModule = await loadWasmModule(
          'wasm/release.wasm',
          this.wasmMemory,
        );

        // Log the WASM exports to confirm
        console.log('WASM Exports: ', wasmModule);
        const bufferSize = 128;

        for (let i = 0; i < max_voices; i++) {
          const parameterPtrs = {
            frequency: wasmModule.allocateF32Array(bufferSize),
            gain: wasmModule.allocateF32Array(bufferSize),
            detune: wasmModule.allocateF32Array(bufferSize),
            gate: wasmModule.allocateF32Array(bufferSize),
          };

          const audioBufPtr = wasmModule.allocateF32Array(bufferSize);
          const offsetsPtr = wasmModule.createBufferOffsets(
            audioBufPtr,
            parameterPtrs.frequency,
            parameterPtrs.gain,
            parameterPtrs.detune,
            parameterPtrs.gate,
          );
          this.wasmPointers.push({
            audioBufferPtr: audioBufPtr,
            envelope1Ptr: wasmModule.createEnvelopeState(0.1, 0.3, 0.5, 0.5),
            parameterPtrs: parameterPtrs,
            offsetsPtr: offsetsPtr,
          });
          console.log(`Voice ${i} pointers:`, {
            audio: audioBufPtr,
            env: this.wasmPointers[i]?.envelope1Ptr,
            params: parameterPtrs,
            offsets: offsetsPtr,
          });
        }

        this.currentInstrument = new Instrument(
          this.audioSystem.destinationNode,
          this.audioSystem.audioContext,
          this.wasmMemory,
        );
        this.destinationNode = this.audioSystem.destinationNode;
      } else {
        console.error('AudioSystem not initialized');
      }
    },
  },
});

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

const max_voices = 8 * 64;
export interface WasmMemoryPointers {
  audioBufferPtr: number;
  envelope1Ptr: number;
  //parametersPtr: Map<string, number>;
};
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
    })
  }),
  getters:
  {
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
        }
      ]
    }
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

        const wasmModule = await loadWasmModule('wasm/release.wasm', this.wasmMemory);

        // Log the WASM exports to confirm
        console.log('WASM Exports: ', wasmModule);
        //const parameterBuffers = new Map<string, number>();
        const bufferSize = 128;
        for (let i = 0; i < max_voices; i++) {
          // for (const param of this.parameterDescriptors) {
          //   const offset = wasmModule.allocateF32Array(bufferSize);
          //   parameterBuffers.set(param.name, offset);
          // }

          this.wasmPointers.push({
            audioBufferPtr: wasmModule.allocateF32Array(bufferSize),
            envelope1Ptr: wasmModule.createEnvelopeState(0.1, 0.2, 0.5, 0.2),
            //parametersPtr: parameterBuffers
          })
        }

        this.currentInstrument = new Instrument(this.audioSystem.destinationNode, this.audioSystem.audioContext, this.wasmMemory);
        this.destinationNode = this.audioSystem.destinationNode;
      } else {
        console.error('AudioSystem not initialized');
      }
    },
  },
});

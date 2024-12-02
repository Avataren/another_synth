// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';
import { type FilterState } from 'src/audio/dsp/variable-comb-filter';
import Instrument from 'src/audio/instrument';
import { type OscillatorState } from 'src/audio/wavetable/wavetable-oscillator';
import { loadWasmModule } from 'src/utils/wasm-loader';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}
const max_instruments = 1;
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
    oscillatorStates: new Map<number, OscillatorState>(),
    envelopeStates: new Map<number, EnvelopeConfig>(),
    filterStates: new Map<number, FilterState>(),
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
        for (let i = 0; i <= 4; i++) {
          this.oscillatorStates.set(i, {
            id: i,
            gain: 1.0,
            detune_oct: 0,
            detune_semi: 0,
            detune_cents: 0,
            detune: 0,
            hardsync: false,
            waveform: 'sine',
            is_active: true
          });
        }

        for (let i = 0; i <= 4; i++) {
          this.envelopeStates.set(i, {
            id: i,
            attack: 0.0,
            decay: 0.1,
            sustain: 0.5,
            release: 0.1,
            attackCurve: 0.0,
            decayCurve: 0.0,
            releaseCurve: 0.0
          });
        }

        for (let i = 0; i <= 2; i++) {
          this.filterStates.set(i, {
            id: i,
            cut: 10000,
            resonance: 0.5,
            is_enabled: false
          } as FilterState)
        }
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
          const osc1State = wasmModule.createOscillatorState();
          console.log('osc1STate:', osc1State);
          const osc2State = wasmModule.createOscillatorState();
          const offsetsPtr = wasmModule.createBufferOffsets(
            audioBufPtr,
            parameterPtrs.frequency,
            parameterPtrs.gain,
            parameterPtrs.detune,
            parameterPtrs.gate,
            osc1State,
            osc2State,
          );
          this.wasmPointers.push({
            audioBufferPtr: audioBufPtr,
            envelope1Ptr: wasmModule.createEnvelopeState(0.01, 0.2, 0.5, 0.25),
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

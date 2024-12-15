// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';
import { type FilterState } from 'src/audio/dsp/filter-state';
import Instrument from 'src/audio/instrument';
import { NoiseType, type NoiseState } from 'src/audio/dsp/noise-generator';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  type SynthLayout,
  type NodeConnection,
  type LfoState,
  VoiceNodeType,
  getNodesOfType,
} from 'src/audio/types/synth-layout';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}


export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
    currentInstrument: null as Instrument | null,
    synthLayout: null as SynthLayout | null,

    // State maps using node IDs from the layout
    oscillatorStates: new Map<number, OscillatorState>(),
    envelopeStates: new Map<number, EnvelopeConfig>(),
    filterStates: new Map<number, FilterState>(),
    lfoStates: new Map<number, LfoState>(),

    // Global states
    noiseState: {
      noiseType: NoiseType.White,
      cutoff: 1.0,
      is_enabled: false
    } as NoiseState,

    wasmMemory: new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    }),
  }),

  getters: {
    getVoiceNodes: (state) => (voiceIndex: number, nodeType: VoiceNodeType) => {
      if (!state.synthLayout) return [];
      const voice = state.synthLayout.voices[voiceIndex];
      return voice ? getNodesOfType(voice, nodeType) : [];
    },

    getNodeState: (state) => (nodeId: number, nodeType: VoiceNodeType) => {
      switch (nodeType) {
        case VoiceNodeType.Oscillator:
          return state.oscillatorStates.get(nodeId);
        case VoiceNodeType.Envelope:
          return state.envelopeStates.get(nodeId);
        case VoiceNodeType.Filter:
          return state.filterStates.get(nodeId);
        case VoiceNodeType.LFO:
          return state.lfoStates.get(nodeId);
        default:
          return null;
      }
    },

    getNodeConnections: (state) => (voiceIndex: number, nodeId: number): NodeConnection[] => {
      if (!state.synthLayout) return [];
      const voice = state.synthLayout.voices[voiceIndex];
      if (!voice) return [];
      return voice.connections.filter(
        conn => conn.fromId === nodeId || conn.toId === nodeId
      );
    },

    maxVoices: (state) => state.synthLayout?.metadata?.maxVoices ?? 8,
    maxOscillators: (state) => state.synthLayout?.metadata?.maxOscillators ?? 2,
    maxEnvelopes: (state) => state.synthLayout?.metadata?.maxEnvelopes ?? 2,
    maxLFOs: (state) => state.synthLayout?.metadata?.maxLFOs ?? 2,
    maxFilters: (state) => state.synthLayout?.metadata?.maxFilters ?? 1,

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

    updateSynthLayout(layout: SynthLayout) {
      this.synthLayout = layout;

      // Initialize states for all nodes
      for (const voice of layout.voices) {
        // Initialize oscillators
        for (const osc of getNodesOfType(voice, VoiceNodeType.Oscillator)) {
          if (!this.oscillatorStates.has(osc.id)) {
            this.oscillatorStates.set(osc.id, {
              id: osc.id,
              phase_mod_amount: 0,
              freq_mod_amount: 0,
              detune_oct: 0,
              detune_semi: 0,
              detune_cents: 0,
              detune: 0,
              hard_sync: false,
              gain: 1,
              active: true
            });
          }
        }

        // Initialize envelopes
        for (const env of getNodesOfType(voice, VoiceNodeType.Envelope)) {
          if (!this.envelopeStates.has(env.id)) {
            this.envelopeStates.set(env.id, {
              id: env.id,
              attack: 0.0,
              decay: 0.1,
              sustain: 0.5,
              release: 0.1,
              attackCurve: 0.0,
              decayCurve: 0.0,
              releaseCurve: 0.0
            });
          }
        }

        // Initialize filters
        for (const filter of getNodesOfType(voice, VoiceNodeType.Filter)) {
          if (!this.filterStates.has(filter.id)) {
            this.filterStates.set(filter.id, {
              id: filter.id,
              cut: 10000,
              resonance: 0.5,
              is_enabled: false
            } as FilterState);
          }
        }

        // Initialize LFOs
        for (const lfo of getNodesOfType(voice, VoiceNodeType.LFO)) {
          if (!this.lfoStates.has(lfo.id)) {
            this.lfoStates.set(lfo.id, {
              id: lfo.id,
              frequency: 2.0,
              waveform: 0,
              useAbsolute: false,
              useNormalized: false,
              triggerMode: 0
            });
          }
        }
      }
    },

    updateOscillator(nodeId: number, state: OscillatorState) {
      this.oscillatorStates.set(nodeId, state);
      this.currentInstrument?.updateOscillatorState(nodeId, state);
    },

    updateEnvelope(nodeId: number, state: EnvelopeConfig) {
      this.envelopeStates.set(nodeId, state);
      this.currentInstrument?.updateEnvelopeState(nodeId, state);
    },

    updateLfo(nodeId: number, state: LfoState) {
      this.lfoStates.set(nodeId, state);
      this.currentInstrument?.updateLfoState(nodeId, state);
    },

    updateFilter(nodeId: number, state: FilterState) {
      this.filterStates.set(nodeId, state);
      this.currentInstrument?.updateFilterState(nodeId, state);
    },

    updateConnection(voiceIndex: number, connection: NodeConnection) {
      if (!this.synthLayout || !this.currentInstrument) return;

      const voice = this.synthLayout.voices[voiceIndex];
      if (!voice) return;

      const existingIndex = voice.connections.findIndex(
        conn => conn.fromId === connection.fromId &&
          conn.toId === connection.toId &&
          conn.target === connection.target
      );

      if (existingIndex !== -1) {
        if (connection.amount === 0) {
          voice.connections.splice(existingIndex, 1);
        } else {
          voice.connections[existingIndex] = connection;
        }
      } else if (connection.amount !== 0) {
        voice.connections.push(connection);
      }

      this.currentInstrument.updateConnection(voiceIndex, connection);
    },

    async setupAudio() {
      if (this.audioSystem) {
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
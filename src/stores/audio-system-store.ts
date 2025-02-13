// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';
import Instrument from 'src/audio/instrument';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  type SynthLayout,
  type NodeConnection,
  type LfoState,
  VoiceNodeType,
  getNodesOfType,
  // type VoiceLayout,
  type NodeConnectionUpdate,
  type FilterState,
} from 'src/audio/types/synth-layout';
import { AudioSyncManager } from 'src/audio/sync-manager';
import {
  WasmModulationType,
  type PortId,
} from 'app/public/wasm/audio_processor';
import { type NoiseState, NoiseType } from 'src/audio/types/noise';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

function debounce<T extends (...args: unknown[]) => void>(
  func: T,
  wait: number,
): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return function (this: ThisParameterType<T>, ...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  } as T;
}

export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
    currentInstrument: null as Instrument | null,
    synthLayout: null as SynthLayout | null,
    syncManager: null as AudioSyncManager | null,
    // State maps using node IDs from the layout
    oscillatorStates: new Map<number, OscillatorState>(),
    envelopeStates: new Map<number, EnvelopeConfig>(),
    filterStates: new Map<number, FilterState>(),
    lfoStates: new Map<number, LfoState>(),
    isUpdatingFromWasm: false,
    isUpdating: false,
    updateQueue: [] as NodeConnectionUpdate[],
    lastUpdateError: null as Error | null,

    // Global states
    noiseState: {
      noiseType: NoiseType.White,
      cutoff: 1.0,
      gain: 1.0,
      is_enabled: false,
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

    getNodeConnectionsForVoice:
      (state) =>
      (voiceIndex: number, nodeId: number): NodeConnection[] => {
        if (!state.synthLayout) return [];
        const voice = state.synthLayout.voices[voiceIndex];
        if (!voice) return [];
        return voice.connections.filter(
          (conn) => conn.fromId === nodeId || conn.toId === nodeId,
        );
      },
    getNodeConnections:
      (state) =>
      (nodeId: number): NodeConnection[] => {
        if (!state.synthLayout) return [];
        const voice = state.synthLayout.voices[0]; // Only look at voice 0
        if (!voice) return [];
        return voice.connections.filter(
          (conn) => conn.fromId === nodeId || conn.toId === nodeId, // Show both incoming and outgoing
        );
      },

    // getNodeConnections:
    //   (state) =>
    //   (nodeId: number): NodeConnection[] => {
    //     if (!state.synthLayout) return [];
    //     const voice = state.synthLayout.voices[0]; // Only look at voice 0
    //     if (!voice) return [];
    //     return voice.connections.filter(
    //       (conn) => conn.fromId === nodeId || conn.toId === nodeId,
    //     );
    //   },

    findNodeById: (state) => (nodeId: number) => {
      if (!state.synthLayout) return null;
      const voice = state.synthLayout.voices[0];
      if (!voice) return null;

      for (const type of Object.values(VoiceNodeType)) {
        const node = voice.nodes[type].find((n) => n.id === nodeId);
        if (node) return { ...node, type };
      }
      return null;
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

    // Helper method to check if connection exists
    hasExistingConnection(fromId: number, toId: number): boolean {
      return (
        this.synthLayout?.voices.some((voice) =>
          voice.connections.some(
            (conn) => conn.fromId === fromId && conn.toId === toId,
          ),
        ) ?? false
      );
    },

    hasMatchingConnection(
      fromId: number,
      toId: number,
      target: PortId,
    ): boolean {
      return (
        this.synthLayout?.voices.some((voice) =>
          voice.connections.some(
            (conn) =>
              conn.fromId === fromId &&
              conn.toId === toId &&
              conn.target === target,
          ),
        ) ?? false
      );
    },

    updateSynthLayout(layout: SynthLayout) {
      console.log('Raw synth layout:', {
        layout: JSON.stringify(layout, null, 2),
        firstVoiceConnections: layout.voices[0]!.connections,
      });
      console.log('Updating synth layout:', layout);
      if (!layout.voices || layout.voices.length === 0) {
        console.warn('No voices in layout');
        return;
      }

      // Use voice 0 as the canonical layout.
      const canonicalVoice = JSON.parse(JSON.stringify(layout.voices[0]));
      const canonicalLayout: SynthLayout = {
        voices: [canonicalVoice],
        globalNodes: layout.globalNodes,
        metadata: layout.metadata ?? {
          maxVoices: 8,
          maxOscillators: 2,
          maxEnvelopes: 2,
          maxLFOs: 2,
          maxFilters: 1,
          stateVersion: 1,
        },
      };

      this.synthLayout = canonicalLayout;

      // Ensure the canonical voice has a connections array.
      this.synthLayout.voices.forEach((voice) => {
        if (!voice.connections) {
          voice.connections = [];
        }
      });

      // Initialize node states from the canonical voice.
      // Initialize node states from the canonical voice.
      for (const voice of this.synthLayout.voices) {
        // Initialize oscillator states
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
              feedback_amount: 0,
              active: true,
            });
          }
        }

        // Initialize filter states
        for (const filter of getNodesOfType(voice, VoiceNodeType.Filter)) {
          if (!this.filterStates.has(filter.id)) {
            this.filterStates.set(filter.id, {
              id: filter.id,
              cutoff: 20000,
              resonance: 0,
              active: true,
            });
          }
        }

        // Initialize envelope states
        for (const env of getNodesOfType(voice, VoiceNodeType.Envelope)) {
          if (!this.envelopeStates.has(env.id)) {
            this.envelopeStates.set(env.id, {
              id: env.id,
              attack: 0.01,
              decay: 0.1,
              sustain: 0.7,
              release: 0.1,
              active: true,
              attackCurve: 0,
              decayCurve: 0,
              releaseCurve: 0,
            });
          }
        }

        // Initialize LFO states
        for (const lfo of getNodesOfType(voice, VoiceNodeType.LFO)) {
          if (!this.lfoStates.has(lfo.id)) {
            this.lfoStates.set(lfo.id, {
              id: lfo.id,
              frequency: 1.0,
              waveform: 0, // Sine
              useAbsolute: false,
              useNormalized: true,
              triggerMode: 0, // None
              gain: 1.0,
              active: true,
            });
          }
        }
      }

      console.log('Updated synth layout state:', this.synthLayout);
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
      this.currentInstrument?.updateLfoState(nodeId, {
        id: nodeId,
        frequency: state.frequency,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active,
      });
    },

    updateFilter(nodeId: number, state: FilterState) {
      this.filterStates.set(nodeId, state);
      this.currentInstrument?.updateFilterState(nodeId, state);
    },

    // Helper to find a connection in a voice
    // findConnection(voice: VoiceLayout, connection: NodeConnection) {
    //   return voice.connections.findIndex(
    //     (conn: NodeConnection) =>
    //       conn.fromId === connection.fromId &&
    //       conn.toId === connection.toId &&
    //       conn.target === connection.target,
    //   );
    // },

    updateConnection(connection: NodeConnectionUpdate) {
      // Instead of immediately processing the update, add it to the queue
      this.updateQueue.push(connection);
      this.debouncedProcessUpdateQueue();
    },

    async processUpdateQueue() {
      if (this.isUpdating) return; // prevent concurrent processing
      this.isUpdating = true;

      while (this.updateQueue.length > 0) {
        const connection = this.updateQueue.shift()!;
        try {
          // Prepare the connection update
          const plainConnection = {
            fromId: Number(connection.fromId),
            toId: Number(connection.toId),
            target: Number(connection.target) as PortId,
            amount: Number(connection.amount),
            isRemoving: Boolean(connection.isRemoving),
            modulationType: connection.modulationType,
          } as NodeConnectionUpdate;

          if (!this.currentInstrument) throw new Error('No instrument');
          await this.currentInstrument.updateConnection(plainConnection);

          // Update the synth layout for every voice
          if (this.synthLayout) {
            this.synthLayout.voices.forEach((voice) => {
              if (!voice.connections) voice.connections = [];

              if (connection.isRemoving) {
                voice.connections = voice.connections.filter(
                  (conn) =>
                    !(
                      conn.fromId === plainConnection.fromId &&
                      conn.toId === plainConnection.toId &&
                      conn.target === plainConnection.target
                    ),
                );
              } else {
                const existingIndex = voice.connections.findIndex(
                  (conn) =>
                    conn.fromId === plainConnection.fromId &&
                    conn.toId === plainConnection.toId &&
                    conn.target === plainConnection.target,
                );

                const newConnection = {
                  fromId: plainConnection.fromId,
                  toId: plainConnection.toId,
                  target: plainConnection.target,
                  amount: plainConnection.amount,
                  modulationType:
                    plainConnection.modulationType || WasmModulationType.VCA,
                };

                if (existingIndex !== -1) {
                  voice.connections[existingIndex] = newConnection;
                } else {
                  voice.connections.push(newConnection);
                }
              }
            });

            // Trigger reactivity update if needed
            this.synthLayout = { ...this.synthLayout };
          }
        } catch (error) {
          console.error('Connection update failed:', error);
          this.lastUpdateError = error as Error;
        }
      }

      this.isUpdating = false;
    },

    // Debounced processor to batch rapid updates
    debouncedProcessUpdateQueue: debounce(function (this: {
      processUpdateQueue: () => Promise<void>;
    }) {
      this.processUpdateQueue();
    }, 100),

    async setupAudio() {
      if (this.audioSystem) {
        this.currentInstrument = new Instrument(
          this.audioSystem.destinationNode,
          this.audioSystem.audioContext,
          this.wasmMemory,
        );
        this.destinationNode = this.audioSystem.destinationNode;
        this.syncManager = new AudioSyncManager();
        this.syncManager.start();
      } else {
        console.error('AudioSystem not initialized');
      }
    },
  },
});

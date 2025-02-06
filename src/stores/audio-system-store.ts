// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import { type EnvelopeConfig } from 'src/audio/dsp/envelope';
import Instrument from 'src/audio/instrument';
import { NoiseType, type NoiseState } from 'src/audio/dsp/noise-generator';
import type OscillatorState from 'src/audio/models/OscillatorState';
import {
  type SynthLayout,
  type NodeConnection,
  type LfoState,
  VoiceNodeType,
  getNodesOfType,
  type VoiceLayout,
  type NodeConnectionUpdate,
  type FilterState,
} from 'src/audio/types/synth-layout';
import { AudioSyncManager } from 'src/audio/sync-manager';
import { type PortId } from 'app/public/wasm/audio_processor';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

// interface StoreConnection {
//   fromId: number;
//   toId: number;
//   target: ModulationTarget;
//   amount: number;
// }

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
          (conn) => conn.fromId === nodeId || conn.toId === nodeId,
        );
      },
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
      console.log('Updating synth layout:', layout);
      console.log('Received layout in store:', JSON.stringify(layout, null, 2));
      console.log(
        'First voice connections in store:',
        JSON.stringify(layout.voices[0]!.connections, null, 2),
      );
      // Create a deep copy to ensure we don't mutate the input directly
      this.synthLayout = JSON.parse(JSON.stringify(layout));

      // Ensure connections array exists for each voice
      this.synthLayout!.voices.forEach((voice) => {
        if (!voice.connections) {
          voice.connections = [];
        }
      });

      // Initialize states for all nodes
      for (const voice of this.synthLayout!.voices) {
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
              feedback_amount: 0,
              active: true,
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
              releaseCurve: 0.0,
              active: true,
            });
          }
        }

        // Initialize filters
        for (const filter of getNodesOfType(voice, VoiceNodeType.Filter)) {
          if (!this.filterStates.has(filter.id)) {
            this.filterStates.set(filter.id, {
              id: filter.id,
              cutoff: 10000,
              resonance: 0.0,
              active: false,
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
              triggerMode: 0,
              gain: 1.0,
              active: false,
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
        active: state.active, // Add this line
      });
    },

    updateFilter(nodeId: number, state: FilterState) {
      this.filterStates.set(nodeId, state);
      this.currentInstrument?.updateFilterState(nodeId, state);
    },
    // Helper to find a connection in a voice
    findConnection(voice: VoiceLayout, connection: NodeConnection) {
      return voice.connections.findIndex(
        (conn: NodeConnection) =>
          conn.fromId === connection.fromId &&
          conn.toId === connection.toId &&
          conn.target === connection.target,
      );
    },
    async updateConnection(connection: NodeConnectionUpdate) {
      if (this.isUpdating) throw new Error('Update in progress');
      this.isUpdating = true;

      try {
        // const numVoices = this.synthLayout?.voices.length || 0;

        // Convert proxies to plain numbers and validate
        const plainConnection = {
          fromId: Number(connection.fromId),
          toId: Number(connection.toId),
          target: Number(connection.target) as PortId,
          amount: Number(connection.amount),
          isRemoving: Boolean(connection.isRemoving),
        } as NodeConnectionUpdate;

        // Validate target
        if (isNaN(plainConnection.target)) {
          throw new Error(`Invalid target value: ${connection.target}`);
        }

        // Update WASM for all voices
        // for (let voiceIndex = 0; voiceIndex < numVoices; voiceIndex++) {
        if (!this.currentInstrument) throw new Error('No instrument');
        await this.currentInstrument.updateConnection(plainConnection);
        // }

        // Update store state
        if (this.synthLayout) {
          this.synthLayout.voices.forEach((voice) => {
            if (!voice.connections) voice.connections = [];

            if (connection.isRemoving) {
              // Only remove the specific connection with matching target
              voice.connections = voice.connections.filter(
                (conn) =>
                  !(
                    conn.fromId === plainConnection.fromId &&
                    conn.toId === plainConnection.toId &&
                    conn.target === plainConnection.target
                  ),
              );
            } else {
              // Add or update connection
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
              };

              if (existingIndex !== -1) {
                voice.connections[existingIndex] = newConnection;
              } else {
                voice.connections.push(newConnection);
              }
            }
          });

          // Force a reactivity update
          this.synthLayout = { ...this.synthLayout };
        }
      } catch (error) {
        console.error('Connection update failed:', error);
        throw error;
      } finally {
        this.isUpdating = false;
      }
    },
    // normalizeTarget(target: ModulationTarget | ModulationTargetOption): ModulationTarget {
    //   if (isModulationTargetObject(target)) {
    //     return target.value;
    //   }
    //   return target;
    // },
    // updateConnectionForVoice(
    //   // voiceIndex: number,
    //   connection: NodeConnectionUpdate,
    // ) {
    //   if (!this.synthLayout || !this.currentInstrument) {
    //     console.error('Cannot update connection: store not initialized');
    //     return;
    //   }

    //   const voice = this.synthLayout.voices[voiceIndex];
    //   if (!voice) {
    //     console.error('Voice not found:', voiceIndex);
    //     return;
    //   }

    //   // Ensure connections array exists
    //   if (!voice.connections) {
    //     voice.connections = [];
    //   }

    //   // Find existing connection with EXACT same routing
    //   const existingIndex = voice.connections.findIndex(
    //     (conn) =>
    //       conn.fromId === connection.fromId &&
    //       conn.toId === connection.toId &&
    //       conn.target === connection.target, // Direct PortId comparison
    //   );

    //   // Log the operation for debugging
    //   console.log('Updating connection:', {
    //     operation: connection.isRemoving
    //       ? 'remove'
    //       : existingIndex !== -1
    //         ? 'update'
    //         : 'add',
    //     existing: existingIndex !== -1,
    //     connection,
    //     currentConnections: voice.connections,
    //   });

    //   if (connection.isRemoving) {
    //     if (existingIndex !== -1) {
    //       // Only remove the specific modulation route
    //       voice.connections.splice(existingIndex, 1);
    //     }
    //   } else {
    //     if (existingIndex !== -1) {
    //       // Update existing connection
    //       voice.connections[existingIndex] = {
    //         fromId: connection.fromId,
    //         toId: connection.toId,
    //         target: connection.target,
    //         amount: connection.amount,
    //       };
    //     } else {
    //       // Add new connection if it doesn't exist
    //       voice.connections.push({
    //         fromId: connection.fromId,
    //         toId: connection.toId,
    //         target: connection.target,
    //         amount: connection.amount,
    //       });
    //     }
    //   }

    //   // Update WASM side with the NodeConnectionUpdate
    //   this.currentInstrument.updateConnection(voiceIndex, connection);
    // },
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

// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import Instrument from 'src/audio/instrument';
import type OscillatorState from 'src/audio/models/OscillatorState';
import type {
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  VelocityState,
} from 'src/audio/types/synth-layout';
import {
  type SynthLayout,
  type NodeConnection,
  type LfoState,
  VoiceNodeType,
  getNodesOfType,
  // type VoiceLayout,
  type NodeConnectionUpdate,
  type FilterState,
  type RawConnection,
  FilterType,
  FilterSlope,
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
    wavetableOscillatorStates: new Map<number, OscillatorState>(),
    envelopeStates: new Map<number, EnvelopeConfig>(),
    convolverStates: new Map<number, ConvolverState>(),
    delayStates: new Map<number, DelayState>(),
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

    velocityState: {
      sensitivity: 1.0,
      randomize: 0.0,
      active: true,
    } as VelocityState,

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
        case VoiceNodeType.Convolver:
          return state.convolverStates.get(nodeId);
        case VoiceNodeType.Delay:
          return state.delayStates.get(nodeId);
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
    convertModulationType(raw: string | undefined): WasmModulationType {
      if (raw === undefined) {
        // If the modulation type is missing, default to Additive.
        return WasmModulationType.Additive;
      }
      switch (raw) {
        case 'VCA':
          return WasmModulationType.VCA;
        case 'Additive':
          return WasmModulationType.Additive;
        case 'Bipolar':
          return WasmModulationType.Bipolar;
        default:
          console.warn('Unknown modulation type:', raw);
          return WasmModulationType.Additive;
      }
    },
    updateSynthLayout(layout: SynthLayout) {
      console.log('Updating synth layout with:', layout);

      // Validate that we have at least one voice.
      if (
        !layout.voices ||
        !Array.isArray(layout.voices) ||
        layout.voices.length === 0
      ) {
        console.warn('Received invalid synth layout (no voices).');
        return;
      }

      // Deep clone the layout so we can modify it safely.
      const layoutClone = JSON.parse(JSON.stringify(layout)) as SynthLayout;

      // Process each voice.
      layoutClone.voices = layoutClone.voices.map((voice) => {
        // --- Convert Connections ---
        if (Array.isArray(voice.connections) && voice.connections.length > 0) {
          // Check if the connections are in raw format by testing for "from_id".
          const firstConn = voice.connections[0]!;
          if ('from_id' in firstConn) {
            // Define an interface for raw connections.

            const rawConnections =
              voice.connections as unknown as RawConnection[];
            voice.connections = rawConnections.map(
              (rawConn: RawConnection): NodeConnection => ({
                fromId: rawConn.from_id,
                toId: rawConn.to_id,
                target: rawConn.target as PortId, // explicit cast
                amount: rawConn.amount,
                modulationType: this.convertModulationType(
                  rawConn.modulation_type,
                ),
              }),
            );
          }
          // Otherwise, assume it's already in the correct format.
        }

        // --- Convert Nodes ---
        // If nodes are given as an array, convert them into an object keyed by VoiceNodeType.
        if (Array.isArray(voice.nodes)) {
          // Create an object with empty arrays for each node type.
          const nodesByType: {
            [key in VoiceNodeType]: { id: number; type: VoiceNodeType }[];
          } = {
            [VoiceNodeType.Oscillator]: [],
            [VoiceNodeType.WavetableOscillator]: [],
            [VoiceNodeType.Filter]: [],
            [VoiceNodeType.Envelope]: [],
            [VoiceNodeType.LFO]: [],
            [VoiceNodeType.Mixer]: [],
            [VoiceNodeType.Noise]: [],
            [VoiceNodeType.GlobalFrequency]: [],
            [VoiceNodeType.GlobalVelocity]: [],
            [VoiceNodeType.Convolver]: [],
            [VoiceNodeType.Delay]: [],
          };

          // Define an interface for raw nodes.
          interface RawNode {
            id: number;
            node_type: string;
          }
          // Helper: convert raw node_type string into our enum.
          const convertNodeType = (raw: string): VoiceNodeType => {
            switch (raw) {
              case 'analog_oscillator':
                return VoiceNodeType.Oscillator;
              case 'filtercollection':
                return VoiceNodeType.Filter;
              case 'envelope':
                return VoiceNodeType.Envelope;
              case 'lfo':
                return VoiceNodeType.LFO;
              case 'mixer':
                return VoiceNodeType.Mixer;
              case 'noise_generator':
                return VoiceNodeType.Noise;
              case 'global_frequency':
                return VoiceNodeType.GlobalFrequency;
              case 'global_velocity':
                return VoiceNodeType.GlobalVelocity;
              case 'wavetable_oscillator':
                return VoiceNodeType.WavetableOscillator;
              case 'convolver':
                return VoiceNodeType.Convolver;
              case 'delay':
                return VoiceNodeType.Delay;

              default:
                console.warn('$$$ Unknown node type:', raw);
                return raw as VoiceNodeType;
            }
          };

          for (const rawNode of voice.nodes as RawNode[]) {
            const type = convertNodeType(rawNode.node_type);
            nodesByType[type].push({ id: rawNode.id, type });
          }
          voice.nodes = nodesByType;
        }

        return voice;
      });

      // Now that we've converted the incoming layout, update our store.
      this.synthLayout = layoutClone;

      // Use the canonical voice (assumed to be voices[0]) to initialize state objects if missing.
      const canonicalVoice = layoutClone.voices[0];
      if (canonicalVoice && canonicalVoice.nodes) {
        for (const conv of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.Convolver,
        ) || []) {
          if (!this.convolverStates.has(conv.id)) {
            this.convolverStates.set(conv.id, {
              id: conv.id,
              wetMix: 0.1,
              active: true,
            });
          }
        }

        for (const delay of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.Delay,
        ) || []) {
          if (!this.delayStates.has(delay.id)) {
            this.delayStates.set(delay.id, {
              id: delay.id,
              delayMs: 500,
              feedback: 0.5,
              wetMix: 0.1,
              active: true,
            });
          }
        }

        // Initialize oscillator states.
        for (const osc of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.Oscillator,
        ) || []) {
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
              waveform: 0,
              active: true,
              unison_voices: 1.0,
              spread: 0,
              wave_index: 0.0,
            });
          }
        }

        for (const osc of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.WavetableOscillator,
        ) || []) {
          if (!this.wavetableOscillatorStates.has(osc.id)) {
            this.wavetableOscillatorStates.set(osc.id, {
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
              waveform: 0,
              active: true,
              unison_voices: 1.0,
              spread: 0,
              wave_index: 0.0,
            });
          }
        }
        // Initialize envelope states.
        for (const env of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.Envelope,
        ) || []) {
          if (!this.envelopeStates.has(env.id)) {
            this.envelopeStates.set(env.id, {
              id: env.id,
              attack: 0.0,
              decay: 0.1,
              sustain: 0.5,
              release: 0.1,
              active: true,
              attackCurve: 0,
              decayCurve: 0,
              releaseCurve: 0,
            });
          }
        }
        // Initialize filter states.
        for (const filter of getNodesOfType(
          canonicalVoice,
          VoiceNodeType.Filter,
        ) || []) {
          if (!this.filterStates.has(filter.id)) {
            this.filterStates.set(filter.id, {
              id: filter.id,
              cutoff: 20000,
              resonance: 0,
              gain: 0.7,
              filter_type: FilterType.LowPass,
              filter_slope: FilterSlope.Db12,
              active: true,
            });
          }
        }
        // Initialize LFO states.
        for (const lfo of getNodesOfType(canonicalVoice, VoiceNodeType.LFO) ||
          []) {
          if (!this.lfoStates.has(lfo.id)) {
            this.lfoStates.set(lfo.id, {
              id: lfo.id,
              frequency: 1.0,
              waveform: 0, // e.g., sine waveform
              phaseOffset: 0.0,
              useAbsolute: false,
              useNormalized: false,
              triggerMode: 0, // None
              gain: 1.0,
              active: true,
              loopMode: 0.0,
              loopStart: 0.5,
              loopEnd: 1.0,
            });
          }
        }
      }

      // Force Vue reactivity by reassigning a shallow copy.
      this.synthLayout = { ...this.synthLayout };
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
        phaseOffset: 0.0,
        waveform: state.waveform,
        useAbsolute: state.useAbsolute,
        useNormalized: state.useNormalized,
        triggerMode: state.triggerMode,
        gain: state.gain,
        active: state.active,
        loopMode: state.loopMode,
        loopStart: state.loopStart,
        loopEnd: state.loopEnd,
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
                    plainConnection.modulationType !== undefined
                      ? plainConnection.modulationType
                      : WasmModulationType.Additive,
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

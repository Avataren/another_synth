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
import { nextTick } from 'process';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

// Shift keys in a Map: for each key > deletedId, subtract 1 and update the state's id.
// function shiftMapKeys<T>(map: Map<number, T>, deletedId: number): Map<number, T> {
//   const newMap = new Map<number, T>();
//   map.forEach((state, key) => {
//     if (key === deletedId) {
//       // Skip deleted key.
//     } else if (key > deletedId) {
//       const newKey = key - 1;
//       newMap.set(newKey, { ...state, id: newKey } as T);
//     } else {
//       newMap.set(key, state);
//     }
//   });
//   return newMap;
// }

// Merge old state with a new node list based on their order.
// newNodes is assumed to be in the correct order.
// For each node, if there is an old state in the same order (by sorted key order),
// we reuse that state (updating its id); otherwise, we create a default.
// function mergeState<T>(
//   oldMap: Map<number, T>,
//   newNodes: { id: number; type: VoiceNodeType }[],
//   defaultState: (id: number) => T
// ): Map<number, T> {
//   const newMap = new Map<number, T>();
//   // Get the old state entries sorted by their key.
//   const oldEntries = Array.from(oldMap.entries()).sort((a, b) => a[0] - b[0]);
//   newNodes.forEach((node, index) => {
//     if (index < oldEntries.length) {
//       const [, oldState] = oldEntries[index]!;
//       newMap.set(node.id, { ...oldState, id: node.id });
//     } else {
//       newMap.set(node.id, defaultState(node.id));
//     }
//   });
//   return newMap;
// }


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
    deletedNodeIds: new Set<number>(),
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
      if (!voice) return [];

      // Get nodes of the specified type
      const nodes = getNodesOfType(voice, nodeType) || [];

      // This is critical - add the type information to each node
      return nodes.map(node => ({
        ...node,
        type: nodeType
      }));
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
    maxOscillators: (state) => state.synthLayout?.metadata?.maxOscillators ?? 4,
    maxEnvelopes: (state) => state.synthLayout?.metadata?.maxEnvelopes ?? 4,
    maxLFOs: (state) => state.synthLayout?.metadata?.maxLFOs ?? 4,
    maxFilters: (state) => state.synthLayout?.metadata?.maxFilters ?? 4,

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

      // Validate that we have at least one voice
      if (!layout.voices || !Array.isArray(layout.voices) || layout.voices.length === 0) {
        console.warn('Received invalid synth layout (no voices).');
        return;
      }

      // Deep clone the layout so we can modify it safely
      const layoutClone = JSON.parse(JSON.stringify(layout)) as SynthLayout;

      // Process each voice: convert raw connections and raw node arrays
      layoutClone.voices = layoutClone.voices.map((voice) => {
        // --- Convert Connections ---
        if (Array.isArray(voice.connections) && voice.connections.length > 0) {
          const firstConn = voice.connections[0]!;
          if ('from_id' in firstConn) {
            const rawConnections = voice.connections as unknown as RawConnection[];
            voice.connections = rawConnections.map((rawConn: RawConnection): NodeConnection => ({
              fromId: rawConn.from_id,
              toId: rawConn.to_id,
              target: rawConn.target as PortId,
              amount: rawConn.amount,
              modulationTransformation: rawConn.modulation_transformation,
              modulationType: this.convertModulationType(rawConn.modulation_type),
            }));
          }
        }

        // --- Convert Nodes ---
        if (Array.isArray(voice.nodes)) {
          const nodesByType: { [key in VoiceNodeType]: { id: number; type: VoiceNodeType }[] } = {
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
            [VoiceNodeType.GateMixer]: [],
            [VoiceNodeType.ArpeggiatorGenerator]: [],
          };

          interface RawNode {
            id: number;
            node_type: string;
          }
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
              case 'gatemixer':
                return VoiceNodeType.GateMixer;
              case 'arpeggiator_generator':
                return VoiceNodeType.ArpeggiatorGenerator;
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

      // Use the canonical voice (assumed to be voices[0]) as our reference
      const canonicalVoice = layoutClone.voices[0];
      if (!canonicalVoice || !canonicalVoice.nodes) {
        console.warn('Canonical voice or its nodes missing in layout');
        return;
      }

      // Log valid node IDs from the canonical voice
      const validIds = new Set<number>();
      Object.values(canonicalVoice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => validIds.add(node.id));
      });
      console.log(`Valid node IDs from canonical voice: ${Array.from(validIds).sort().join(', ')}`);

      // --- Trigger Vue Reactivity ---
      this.synthLayout = { ...layoutClone };

      // Initialize default states for all nodes
      this.initializeDefaultStates();

      // Clear any deletion markers since the WASM layout is now definitive
      this.deletedNodeIds.clear();
    }
    ,
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

    debugNodeState() {
      if (!this.synthLayout) return;

      // Get the canonical voice
      const voice = this.synthLayout.voices[0];
      if (!voice) return;

      console.log('Current node state:');

      // For each node type, log the node IDs and their corresponding state
      Object.values(VoiceNodeType).forEach(type => {
        const nodes = getNodesOfType(voice, type) || [];
        console.log(`${type} nodes:`, nodes.map(n => n.id));

        // Check if each node has corresponding state
        switch (type) {
          case VoiceNodeType.Oscillator:
            console.log(`${type} states:`, Array.from(this.oscillatorStates.keys()));
            break;
          case VoiceNodeType.WavetableOscillator:
            console.log(`${type} states:`, Array.from(this.wavetableOscillatorStates.keys()));
            break;
          case VoiceNodeType.Envelope:
            console.log(`${type} states:`, Array.from(this.envelopeStates.keys()));
            break;
          case VoiceNodeType.LFO:
            console.log(`${type} states:`, Array.from(this.lfoStates.keys()));
            break;
          // Add other node types as needed
        }
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
            modulationTransformation: connection.modulationTransformation,
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
                  modulationTransformation:
                    plainConnection.modulationTransformation,
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
    // Add to audio-system-store.ts in the actions section
    // In audio-system-store.ts
    // In audio-system-store.ts

    async deleteNodeCleanup(deletedNodeId: number): Promise<void> {
      console.log(`Starting node cleanup for deleted node ${deletedNodeId}`);

      try {
        // Mark node as deleted
        this.deletedNodeIds.add(deletedNodeId);

        // Store the node type for debugging
        const nodeType = this.findNodeById(deletedNodeId)?.type;
        console.log(`Deleted node type: ${nodeType || 'unknown'}`);

        // Analyze current state before deletion
        // this.verifyOscillatorStates();

        // Wait for the WebAssembly to complete the deletion
        await new Promise(resolve => setTimeout(resolve, 100));

        // Force a sync with WebAssembly to get the latest state
        if (this.currentInstrument) {
          const wasmStateJson = await this.currentInstrument.getWasmNodeConnections();

          if (wasmStateJson) {
            // Parse the WebAssembly state
            const wasmState = JSON.parse(wasmStateJson);

            // IMPORTANT: Create deep clones of all state maps
            // Use JSON methods to ensure complete decoupling from original objects
            const savedOscillatorStates = new Map(
              Array.from(this.oscillatorStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedWavetableOscillatorStates = new Map(
              Array.from(this.wavetableOscillatorStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedEnvelopeStates = new Map(
              Array.from(this.envelopeStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedLfoStates = new Map(
              Array.from(this.lfoStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedFilterStates = new Map(
              Array.from(this.filterStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedDelayStates = new Map(
              Array.from(this.delayStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            const savedConvolverStates = new Map(
              Array.from(this.convolverStates.entries()).map(
                ([id, state]) => [id, JSON.parse(JSON.stringify(state))]
              )
            );

            // DEBUG: Check saved oscillator states
            console.log('BEFORE SHIFTING: Saved oscillator states:');
            savedOscillatorStates.forEach((state, id) => {
              console.log(`Oscillator ${id}: waveform=${state.waveform}, gain=${state.gain}`);
            });

            // Helper function to handle ID shifting
            const shiftNodeId = (id: number): number => {
              return id > deletedNodeId ? id - 1 : id;
            };

            // Create explicit, new state maps with shifted IDs
            // For oscillator states, explicitly copy all properties
            const shiftedOscillatorStates = new Map<number, OscillatorState>();
            savedOscillatorStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                // Create explicit copy with all properties
                const newState: OscillatorState = {
                  id: newId,
                  phase_mod_amount: state.phase_mod_amount,
                  freq_mod_amount: state.freq_mod_amount,
                  detune_oct: state.detune_oct,
                  detune_semi: state.detune_semi,
                  detune_cents: state.detune_cents,
                  detune: state.detune,
                  hard_sync: state.hard_sync,
                  gain: state.gain,
                  feedback_amount: state.feedback_amount,
                  waveform: state.waveform, // Critical property
                  active: state.active,
                  unison_voices: state.unison_voices,
                  spread: state.spread,
                  wave_index: state.wave_index
                };
                shiftedOscillatorStates.set(newId, newState);
                console.log(`Shifted oscillator ${id} → ${newId}, waveform=${state.waveform} → ${newState.waveform}`);
              }
            });

            // Repeat pattern for each state type
            // Wavetable oscillators
            const shiftedWavetableOscillatorStates = new Map<number, OscillatorState>();
            savedWavetableOscillatorStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                const newState: OscillatorState = {
                  id: newId,
                  phase_mod_amount: state.phase_mod_amount,
                  freq_mod_amount: state.freq_mod_amount,
                  detune_oct: state.detune_oct,
                  detune_semi: state.detune_semi,
                  detune_cents: state.detune_cents,
                  detune: state.detune,
                  hard_sync: state.hard_sync,
                  gain: state.gain,
                  feedback_amount: state.feedback_amount,
                  waveform: state.waveform,
                  active: state.active,
                  unison_voices: state.unison_voices,
                  spread: state.spread,
                  wave_index: state.wave_index
                };
                shiftedWavetableOscillatorStates.set(newId, newState);
              }
            });

            // Other state types follow same pattern
            const shiftedEnvelopeStates = new Map<number, EnvelopeConfig>();
            savedEnvelopeStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                shiftedEnvelopeStates.set(newId, {
                  ...state,
                  id: newId
                });
              }
            });

            const shiftedLfoStates = new Map<number, LfoState>();
            savedLfoStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                shiftedLfoStates.set(newId, {
                  ...state,
                  id: newId
                });
              }
            });

            const shiftedFilterStates = new Map<number, FilterState>();
            savedFilterStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                shiftedFilterStates.set(newId, {
                  ...state,
                  id: newId
                });
              }
            });

            const shiftedDelayStates = new Map<number, DelayState>();
            savedDelayStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                shiftedDelayStates.set(newId, {
                  ...state,
                  id: newId
                });
              }
            });

            const shiftedConvolverStates = new Map<number, ConvolverState>();
            savedConvolverStates.forEach((state, id) => {
              if (id !== deletedNodeId) {
                const newId = shiftNodeId(id);
                shiftedConvolverStates.set(newId, {
                  ...state,
                  id: newId
                });
              }
            });

            // DEBUG: Check shifted oscillator states
            console.log('AFTER SHIFTING: New oscillator states:');
            shiftedOscillatorStates.forEach((state, id) => {
              console.log(`Oscillator ${id}: waveform=${state.waveform}, gain=${state.gain}`);
            });

            // Temporarily set synthLayout to null to force reactivity
            //this.synthLayout = null;

            // Wait for Vue to process the null update
            await nextTick(() => {
              // Force a complete update of the synth layout
              this.updateSynthLayout(wasmState);

              // Replace state maps with the shifted versions
              // Use direct assignment to ensure Vue sees the changes
              this.oscillatorStates = shiftedOscillatorStates;
              this.wavetableOscillatorStates = shiftedWavetableOscillatorStates;
              this.envelopeStates = shiftedEnvelopeStates;
              this.lfoStates = shiftedLfoStates;
              this.filterStates = shiftedFilterStates;
              this.delayStates = shiftedDelayStates;
              this.convolverStates = shiftedConvolverStates;

              // Initialize default states only for nodes that don't have state yet
              this.initializeDefaultStates();

              // Update WASM with the preserved states
              //this.applyPreservedStatesToWasm();

              // Verify final state
              this.verifyOscillatorStates();
            });
          }
        }
      } catch (error) {
        console.error('Error during node cleanup:', error);
      } finally {
        // Remove the deleted marker
        setTimeout(() => {
          this.deletedNodeIds.delete(deletedNodeId);
        }, 300);
      }
    },

    // Add this helper method to verify state consistency
    verifyOscillatorStates() {
      console.log('--------- OSCILLATOR STATE VERIFICATION ---------');

      if (!this.synthLayout) {
        console.log('No synth layout available');
        return;
      }

      const voice = this.synthLayout.voices[0];
      if (!voice) {
        console.log('No voice available');
        return;
      }

      // Get all oscillator nodes from the layout
      const analogOscillators = getNodesOfType(voice, VoiceNodeType.Oscillator) || [];

      console.log(`Found ${analogOscillators.length} analog oscillators in layout`);
      console.log(`Found ${this.oscillatorStates.size} oscillator states in store`);

      // Check each oscillator node against its stored state
      analogOscillators.forEach(osc => {
        const state = this.oscillatorStates.get(osc.id);
        if (state) {
          console.log(`Oscillator ${osc.id}: waveform=${state.waveform}, gain=${state.gain}`);
        } else {
          console.log(`Oscillator ${osc.id}: NO STATE FOUND`);
        }
      });

      // Check for any orphaned states (states without nodes)
      this.oscillatorStates.forEach((state, id) => {
        const node = analogOscillators.find(n => n.id === id);
        if (!node) {
          console.log(`Orphaned state for oscillator ${id}: waveform=${state.waveform}`);
        }
      });
    },
    // Improved applyPreservedStatesToWasm function
    applyPreservedStatesToWasm() {
      if (!this.currentInstrument) return;

      // Apply analog oscillator states
      // In applyPreservedStatesToWasm
      this.oscillatorStates.forEach((state, nodeId) => {
        console.log('Reapplying analog oscillator state for node', nodeId, state);
        // Log the specific waveform value to verify it's being passed correctly
        console.log(`## Oscillator ${nodeId} waveform value being reapplied: ${state.waveform}`);
        this.currentInstrument?.updateOscillatorState(nodeId, {
          ...state,
          id: nodeId,
          // Explicitly ensure waveform is preserved
          waveform: state.waveform
        });

      });

      // Apply wavetable oscillator states (with proper type conversion)
      this.wavetableOscillatorStates.forEach((state, nodeId) => {
        console.log('Reapplying wavetable oscillator state for node', nodeId, state);
        this.currentInstrument?.updateWavetableOscillatorState(nodeId, {
          ...state,
          // Ensure ID is consistent
          id: nodeId
        });
      });

      // Apply envelope states
      this.envelopeStates.forEach((state, nodeId) => {
        console.log('Reapplying envelope state for node', nodeId, state);
        this.currentInstrument?.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId
        });
      });

      // Apply LFO states (handle all properties explicitly)
      this.lfoStates.forEach((state, nodeId) => {
        console.log('Reapplying LFO state for node', nodeId, state);
        this.currentInstrument?.updateLfoState(nodeId, {
          id: nodeId,
          frequency: state.frequency,
          phaseOffset: state.phaseOffset || 0.0,
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
      });

      // Apply filter states
      this.filterStates.forEach((state, nodeId) => {
        console.log('Reapplying filter state for node', nodeId, state);
        this.currentInstrument?.updateFilterState(nodeId, {
          ...state,
          id: nodeId
        });
      });

      // Add convolver states
      this.convolverStates.forEach((state, nodeId) => {
        console.log('Reapplying convolver state for node', nodeId, state);
        if (this.currentInstrument?.updateConvolverState) {
          this.currentInstrument.updateConvolverState(nodeId, {
            ...state,
            id: nodeId
          });
        }
      });

      // Add delay states
      this.delayStates.forEach((state, nodeId) => {
        console.log('Reapplying delay state for node', nodeId, state);
        if (this.currentInstrument?.updateDelayState) {
          this.currentInstrument.updateDelayState(nodeId, {
            ...state,
            id: nodeId
          });
        }
      });
    },
    // Add this method to initialize default states
    initializeDefaultStates() {
      if (!this.synthLayout) return;

      const voice = this.synthLayout.voices[0];
      if (!voice) return;

      // Initialize oscillator states
      const analogOscillators = getNodesOfType(voice, VoiceNodeType.Oscillator) || [];
      analogOscillators.forEach(osc => {
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
            unison_voices: 1,
            spread: 0,
            wave_index: 0,
          });
        }
      });

      // Initialize wavetable oscillator states
      const wavetableOscillators = getNodesOfType(voice, VoiceNodeType.WavetableOscillator) || [];
      wavetableOscillators.forEach(osc => {
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
            unison_voices: 1,
            spread: 0,
            wave_index: 0,
          });
        }
      });

      // Initialize envelope states
      const envelopes = getNodesOfType(voice, VoiceNodeType.Envelope) || [];
      envelopes.forEach(env => {
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
      });

      // Initialize LFO states
      const lfos = getNodesOfType(voice, VoiceNodeType.LFO) || [];
      lfos.forEach(lfo => {
        if (!this.lfoStates.has(lfo.id)) {
          this.lfoStates.set(lfo.id, {
            id: lfo.id,
            frequency: 1.0,
            waveform: 0,
            phaseOffset: 0.0,
            useAbsolute: false,
            useNormalized: false,
            triggerMode: 0,
            gain: 1.0,
            active: true,
            loopMode: 0.0,
            loopStart: 0.5,
            loopEnd: 1.0,
          });
        }
      });

      // First, add the filter initialization to the initializeDefaultStates method
      const filters = getNodesOfType(voice, VoiceNodeType.Filter) || [];
      filters.forEach(filter => {
        if (!this.filterStates.has(filter.id)) {
          this.filterStates.set(filter.id, {
            id: filter.id,
            cutoff: 20000,
            resonance: 0,
            keytracking: 0,
            comb_frequency: 220,
            comb_dampening: 0.5,
            oversampling: 0,
            gain: 0.7,
            filter_type: FilterType.LowPass,
            filter_slope: FilterSlope.Db12,
            active: true,
          });
        }
      });

    }
    ,
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

// src/stores/audio-system-store.ts
// REFACTORED: This store now only contains core audio infrastructure
// Domain logic has been moved to focused stores:
// - patch-store.ts: Patch/bank management
// - node-state-store.ts: Node state cache
// - connection-store.ts: Connection management
// - asset-store.ts: Audio asset management
// - layout-store.ts: Layout and connections
// State is mirrored here via legacy-store-bridge.ts for backward compatibility

import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type OscillatorState from 'src/audio/models/OscillatorState';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  FilterState,
  LfoState,
  ReverbState,
  SamplerState,
  VelocityState,
} from 'src/audio/types/synth-layout';
import {
  type SynthLayout,
  type NodeConnection,
  VoiceNodeType,
  getNodesOfType,
} from 'src/audio/types/synth-layout';
import { AudioSyncManager } from 'src/audio/sync-manager';
import { type NoiseState, NoiseType } from 'src/audio/types/noise';

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    // Core audio infrastructure
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
    currentInstrument: null as InstrumentV2 | null,
    syncManager: null as AudioSyncManager | null,
    wasmMemory: new WebAssembly.Memory({
      initial: 256,
      maximum: 1024,
      shared: true,
    }),

    // ============================================================================
    // MIRRORED STATE FROM FOCUSED STORES (via legacy-store-bridge.ts)
    // These are kept for backward compatibility with existing components
    // DO NOT modify these directly - use the focused stores instead
    // ============================================================================

    synthLayout: null as SynthLayout | null,

    // Node state caches (mirrored from node-state-store)
    oscillatorStates: new Map<string, OscillatorState>(),
    wavetableOscillatorStates: new Map<string, OscillatorState>(),
    samplerStates: new Map<string, SamplerState>(),
    samplerWaveforms: new Map<string, Float32Array>(),
    envelopeStates: new Map<string, EnvelopeConfig>(),
    convolverStates: new Map<string, ConvolverState>(),
    delayStates: new Map<string, DelayState>(),
    filterStates: new Map<string, FilterState>(),
    lfoStates: new Map<string, LfoState>(),
    chorusStates: new Map<string, ChorusState>(),
    reverbStates: new Map<string, ReverbState>(),

    // Global states (mirrored from node-state-store)
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

    // Patch state (mirrored from patch-store)
    currentBank: null as never, // Kept for type compatibility
    currentPatchId: null as never, // Kept for type compatibility
    audioAssets: new Map<never, never>(), // Kept for type compatibility
    defaultPatchTemplate: null as never, // Kept for type compatibility
    defaultPatchLoadAttempted: false,

    // Layout state flags (mirrored from layout-store)
    isUpdatingFromWasm: false,
    deletedNodeIds: new Set<string>(),

    // Connection state flags (mirrored from connection-store)
    updateQueue: [] as never[], // Kept for type compatibility
    lastUpdateError: null as Error | null,
    isUpdating: false,

    // Patch loading flag (mirrored from patch-store)
    isLoadingPatch: false,
  }),

  getters: {
    // Backward compatibility getters - read from mirrored state
    getVoiceNodes: (state) => (voiceIndex: number, nodeType: VoiceNodeType) => {
      if (!state.synthLayout) return [];
      const voice = state.synthLayout.voices[voiceIndex];
      if (!voice) return [];

      const nodes = getNodesOfType(voice, nodeType) || [];
      return nodes.map((node) => ({
        ...node,
        type: nodeType,
      }));
    },

    getNodeState: (state) => (nodeId: string, nodeType: VoiceNodeType) => {
      switch (nodeType) {
        case VoiceNodeType.Oscillator:
          return state.oscillatorStates.get(nodeId);
        case VoiceNodeType.WavetableOscillator:
          return state.wavetableOscillatorStates.get(nodeId);
        case VoiceNodeType.Sampler:
          return state.samplerStates.get(nodeId);
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
        case VoiceNodeType.Chorus:
          return state.chorusStates.get(nodeId);
        default:
          return null;
      }
    },

    getNodeConnectionsForVoice:
      (state) =>
        (voiceIndex: number, nodeId: string): NodeConnection[] => {
          if (!state.synthLayout) return [];
          const voice = state.synthLayout.voices[voiceIndex];
          if (!voice) return [];
          return voice.connections.filter(
            (conn) => conn.fromId === nodeId || conn.toId === nodeId,
          );
        },

    getNodeConnections:
      (state) =>
        (nodeId: string): NodeConnection[] => {
          if (!state.synthLayout) return [];
          const voice = state.synthLayout.voices[0];
          if (!voice) return [];
          return voice.connections.filter(
            (conn) => conn.fromId === nodeId || conn.toId === nodeId,
          );
        },

    findNodeById: (state) => (nodeId: string) => {
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
    // ============================================================================
    // CORE AUDIO INFRASTRUCTURE
    // These methods remain because they manage the core audio system
    // ============================================================================

    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = new AudioSystem();
      }
    },

    // ============================================================================
    // COMPATIBILITY WRAPPERS
    // These delegate to the focused stores for backward compatibility
    // ============================================================================

    updateSynthLayout(layout: SynthLayout) {
      // Delegate to layout-store
      const { useLayoutStore } = require('./layout-store');
      const layoutStore = useLayoutStore();
      layoutStore.updateSynthLayout(layout);
    },

    async setupAudio() {
      if (this.audioSystem) {
        this.currentInstrument = new InstrumentV2(
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

    async waitForInstrumentReady(timeoutMs = 8000): Promise<boolean> {
      const pollInterval = 50;
      const start = Date.now();

      while (
        !this.currentInstrument ||
        !this.currentInstrument.isReady
      ) {
        if (Date.now() - start > timeoutMs) {
          console.warn('Timed out waiting for instrument readiness');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return true;
    },

    async waitForSynthLayout(timeoutMs = 8000): Promise<boolean> {
      const pollInterval = 50;
      const start = Date.now();
      const requiredVoices = this.currentInstrument?.num_voices ?? 1;

      while (
        !this.synthLayout ||
        !Array.isArray(this.synthLayout.voices) ||
        this.synthLayout.voices.length < requiredVoices ||
        !this.synthLayout.voices[0] ||
        !this.synthLayout.voices[0]!.nodes
      ) {
        if (Date.now() - start > timeoutMs) {
          console.warn('Timed out waiting for synth layout');
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }

      return true;
    },
  },
});

// src/stores/audioSystem.ts
import { defineStore } from 'pinia';
import AudioSystem from 'src/audio/AudioSystem';
import InstrumentV2 from 'src/audio/instrument-v2';
import type OscillatorState from 'src/audio/models/OscillatorState';
import type {
  ChorusState,
  ConvolverState,
  DelayState,
  EnvelopeConfig,
  ReverbState,
  SamplerState,
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
  SamplerLoopMode,
  SamplerTriggerMode,
  cloneVoiceLayout,
} from 'src/audio/types/synth-layout';
import { AudioSyncManager } from 'src/audio/sync-manager';
import {
  ModulationTransformation,
  WasmModulationType,
  type PortId,
} from 'app/public/wasm/audio_processor';
import { type NoiseState, NoiseType } from 'src/audio/types/noise';
import { nextTick } from 'process';
import type {
  Bank,
  Patch,
  AudioAsset,
  PatchMetadata,
} from 'src/audio/types/preset-types';
import { createDefaultPatchMetadata } from 'src/audio/types/preset-types';
import {
  serializeCurrentPatch,
  deserializePatch,
  exportPatchToJSON,
  importPatchFromJSON,
  parseAudioAssetId,
  createAudioAssetId,
} from 'src/audio/serialization/patch-serializer';
import {
  createBank,
  exportBankToJSON,
  importBankFromJSON,
  addPatchToBank,
  removePatchFromBank,
  updatePatchInBank,
} from 'src/audio/serialization/bank-serializer';
import {
  extractAllAudioAssets,
  getSamplerNodeIds,
  getConvolverNodeIds,
} from 'src/audio/serialization/audio-asset-extractor';

function clonePatch(patch: Patch): Patch {
  return JSON.parse(JSON.stringify(patch)) as Patch;
}

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

const DEFAULT_SAMPLE_RATE = 44100;

function createDefaultSamplerState(id: string): SamplerState {
  return {
    id,
    frequency: 440,
    gain: 1.0,
    loopMode: SamplerLoopMode.Off,
    loopStart: 0,
    loopEnd: 1,
    sampleLength: DEFAULT_SAMPLE_RATE,
    rootNote: 60,
    triggerMode: SamplerTriggerMode.Gate,
    active: true,
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: 1,
  };
}

export const useAudioSystemStore = defineStore('audioSystem', {
  state: () => ({
    audioSystem: null as AudioSystem | null,
    destinationNode: null as AudioNode | null,
    currentInstrument: null as InstrumentV2 | null,
    synthLayout: null as SynthLayout | null,
    syncManager: null as AudioSyncManager | null,
    // State maps using node IDs from the layout
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
    isUpdatingFromWasm: false,
    isUpdating: false,
    isLoadingPatch: false,
    updateQueue: [] as NodeConnectionUpdate[],
    lastUpdateError: null as Error | null,
    deletedNodeIds: new Set<string>(),
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

    // Preset/Patch Management
    currentBank: null as Bank | null,
    currentPatchId: null as string | null,
    audioAssets: new Map<string, AudioAsset>(),
    defaultPatchTemplate: null as Patch | null,
    defaultPatchLoadAttempted: false,
  }),

  getters: {
    getVoiceNodes: (state) => (voiceIndex: number, nodeType: VoiceNodeType) => {
      if (!state.synthLayout) return [];
      const voice = state.synthLayout.voices[voiceIndex];
      if (!voice) return [];

      // Get nodes of the specified type
      const nodes = getNodesOfType(voice, nodeType) || [];

      // This is critical - add the type information to each node
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
    initializeAudioSystem() {
      if (!this.audioSystem) {
        this.audioSystem = new AudioSystem();
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

    async fetchDefaultPatchTemplate(): Promise<Patch | null> {
      if (this.defaultPatchTemplate) {
        return this.defaultPatchTemplate;
      }

      if (this.defaultPatchLoadAttempted) {
        return null;
      }

      this.defaultPatchLoadAttempted = true;

      if (typeof fetch === 'undefined') {
        console.warn('Fetch API unavailable; cannot load default patch file');
        return null;
      }

      try {
        const response = await fetch(
          `${import.meta.env.BASE_URL}default-patch.json`,
          { cache: 'no-store' },
        );

        if (!response.ok) {
          if (response.status !== 404) {
            console.warn(
              `Failed to fetch default patch (status ${response.status})`,
            );
          }
          return null;
        }

        const json = await response.text();
        const result = importPatchFromJSON(json);

        if (!result.validation.valid || !result.patch) {
          console.error(
            'Default patch validation failed:',
            result.validation.errors?.join(', '),
          );
          return null;
        }

        this.defaultPatchTemplate = result.patch;
        return this.defaultPatchTemplate;
      } catch (error) {
        console.error('Error loading default patch:', error);
        return null;
      }
    },

    async loadSystemBankIfPresent(): Promise<boolean> {
      if (this.currentBank && this.currentBank.patches.length > 0) {
        return true;
      }

      if (typeof fetch === 'undefined') {
        console.warn('Fetch API unavailable; cannot load system bank file');
        return false;
      }

      const url = `${import.meta.env.BASE_URL}system-bank.json`;

      try {
        const response = await fetch(url, { cache: 'no-store' });

        if (response.status === 404) {
          // No system bank provided in the deployment – fall back to defaults
          return false;
        }

        if (!response.ok) {
          console.error(
            `Failed to fetch system bank (status ${response.status})`,
          );
          return false;
        }

        const json = await response.text();
        if (!json.trim()) {
          console.warn('System bank file was empty');
          return false;
        }

        const result = importBankFromJSON(json);

        if (!result.validation.valid || !result.bank) {
          console.error(
            'System bank validation failed:',
            result.validation.errors?.join(', '),
          );
          return false;
        }

        if (result.validation.warnings?.length) {
          console.warn(
            'System bank import warnings:',
            result.validation.warnings.join(', '),
          );
        }

        const bank = result.bank;
        if (bank.patches.length === 0) {
          console.warn(
            `System bank "${bank.metadata.name}" did not contain any patches`,
          );
          return false;
        }

        const firstPatch = bank.patches[0]!;
        const applied = await this.applyPatchObject(firstPatch);
        if (!applied) {
          console.error(
            `Failed to apply initial patch "${firstPatch.metadata.name}" from system bank`,
          );
          return false;
        }

        this.currentBank = bank;
        this.currentPatchId = firstPatch.metadata.id;

        console.log(
          `Loaded system bank "${bank.metadata.name}" with ${bank.patches.length} patches`,
        );
        return true;
      } catch (error) {
        console.error('Error loading system bank:', error);
        return false;
      }
    },

    ensurePatchInBank(patch: Patch) {
      if (!patch) return;

      if (!this.currentBank) {
        this.currentBank = createBank('Default Bank', [clonePatch(patch)]);
        return;
      }

      const exists = this.currentBank.patches.some(
        (existing) => existing.metadata.id === patch.metadata.id,
      );

      if (!exists) {
        this.currentBank = addPatchToBank(this.currentBank, clonePatch(patch));
      }
    },

    async applyPatchObject(
      patch: Patch,
      options?: { setCurrentPatchId?: boolean },
    ): Promise<boolean> {
      try {
        console.log('[applyPatchObject] Loading patch:', patch.metadata.name);

        // Wait for instrument to be ready (not layout, since we're providing the layout)
        const instrumentReady = await this.waitForInstrumentReady();
        if (!instrumentReady) {
          console.warn('Cannot apply patch because instrument is not ready');
          return false;
        }

        const deserialized = deserializePatch(patch);
        console.log('[applyPatchObject] Deserialized sampler states:', Array.from(deserialized.samplers.keys()));
        console.log('[applyPatchObject] Deserialized layout sampler nodes:', deserialized.layout.voices[0]?.nodes[VoiceNodeType.Sampler] || []);

        // Set loading flag to prevent redundant watcher updates
        this.isLoadingPatch = true;

        // Send the patch to WASM FIRST, before we modify any state
        // This ensures we're sending the original patch object with plain objects, not Maps
        // NOTE: loadPatch is fire-and-forget until worklet is updated to send responses
        this.currentInstrument?.loadPatch(patch);

        // Update the layout from the patch (this processes connections and nodes)
        this.updateSynthLayout(deserialized.layout);

        // Note: InstrumentV2 doesn't have updateLayout() - it doesn't store layout locally
        // WASM is the single source of truth for layout

        // Update all state maps from the patch
        this.oscillatorStates = deserialized.oscillators;
        this.wavetableOscillatorStates = deserialized.wavetableOscillators;
        this.filterStates = deserialized.filters;
        this.envelopeStates = deserialized.envelopes;
        this.lfoStates = deserialized.lfos;
        this.samplerStates = deserialized.samplers;
        console.log('[applyPatchObject] After assignment, samplerStates:', Array.from(this.samplerStates.keys()));
        this.convolverStates = deserialized.convolvers;
        this.delayStates = deserialized.delays;
        this.chorusStates = deserialized.choruses;
        this.reverbStates = deserialized.reverbs;

        if (deserialized.noise) {
          this.noiseState = deserialized.noise;
        }
        if (deserialized.velocity) {
          this.velocityState = deserialized.velocity;
        }

        this.audioAssets = deserialized.audioAssets;

        if (options?.setCurrentPatchId !== false) {
          this.currentPatchId = patch.metadata.id;
        }

        // Restore audio assets (sample data, impulse responses, etc.) to WASM
        await this.restoreAudioAssets();

        // Clear the loading flag - the worklet will send back its authoritative layout
        // which will override our temporary instrument layout update
        this.isLoadingPatch = false;

        return true;
      } catch (error) {
        console.error('Failed to apply patch:', error);
        return false;
      }
    },

    async initializeFromDefaultPatch(): Promise<boolean> {
      const template = await this.fetchDefaultPatchTemplate();
      if (!template) {
        return false;
      }

      const patchInstance = clonePatch(template);
      this.ensurePatchInBank(patchInstance);

      const success = await this.applyPatchObject(patchInstance);
      if (!success) {
        console.warn('Unable to apply default patch');
      }
      return success;
    },

    async prepareStateForNewPatch(): Promise<boolean> {
      const layoutReady = await this.waitForSynthLayout();
      if (!layoutReady) {
        console.warn('Cannot prepare new patch: synth layout not ready');
        return false;
      }
      await this.waitForInstrumentReady();

      this.resetCurrentStateToDefaults(false);

      const template = await this.fetchDefaultPatchTemplate();
      if (template) {
        const patchInstance = clonePatch(template);
        const applied = await this.applyPatchObject(patchInstance, {
          setCurrentPatchId: false,
        });
        if (applied) {
          await nextTick(() => {
            this.applyPreservedStatesToWasm();
            void this.restoreAudioAssets();
          });
          return true;
        }
      }

      this.applyPreservedStatesToWasm();
      return false;
    },

    async createNewPatchFromTemplate(name: string): Promise<Patch | null> {
      const targetName = name?.trim() || 'New Patch';
      const template = await this.fetchDefaultPatchTemplate();

      if (template) {
        const patchInstance = clonePatch(template);
        const newMetadata = createDefaultPatchMetadata(targetName);
        patchInstance.metadata = {
          ...patchInstance.metadata,
          ...newMetadata,
          name: targetName,
        };

        const applied = await this.applyPatchObject(patchInstance);
        if (applied) {
          if (this.currentBank) {
            this.currentBank = addPatchToBank(this.currentBank, patchInstance);
          } else {
            this.currentBank = createBank('Default Bank', [patchInstance]);
          }
          this.currentPatchId = patchInstance.metadata.id;
          console.log(
            `New patch "${patchInstance.metadata.name}" created from default template`,
          );
          return patchInstance;
        }

        console.warn(
          'Failed to apply default patch template; falling back to baseline new patch flow',
        );
      }

      const prepared = await this.prepareStateForNewPatch();
      if (!prepared) {
        console.warn('Unable to prepare synth state for new patch');
        return null;
      }

      return await this.saveCurrentPatch(targetName);
    },

    applyTemplateToCurrentLayout(template: Patch): boolean {
      if (!this.synthLayout) {
        console.warn('Cannot apply template: synth layout missing');
        return false;
      }

      const canonicalVoice = this.synthLayout.voices[0];
      if (!canonicalVoice) {
        console.warn('Cannot apply template: canonical voice missing');
        return false;
      }

      const templateState = deserializePatch(template);
      const nodeIdRemap = new Map<string, string>();

      const assignStates = <T extends { id?: string }>(
        nodeType: VoiceNodeType,
        templateMap: Map<string, T>,
        targetMap: Map<string, T>,
      ) => {
        const nodes = getNodesOfType(canonicalVoice, nodeType) || [];
        const orderedTemplates = Array.from(templateMap.entries()).sort(([a], [b]) =>
          a.localeCompare(b),
        );

        nodes.forEach((node, index) => {
          const templateEntry = orderedTemplates[index];
          if (!templateEntry) return;
          const [templateId, templateValue] = templateEntry;
          const assignedState = {
            ...templateValue,
            id: node.id,
          };
          targetMap.set(node.id, assignedState as T);
          nodeIdRemap.set(templateId, node.id);
        });
      };

      assignStates(
        VoiceNodeType.Oscillator,
        templateState.oscillators,
        this.oscillatorStates,
      );
      assignStates(
        VoiceNodeType.WavetableOscillator,
        templateState.wavetableOscillators,
        this.wavetableOscillatorStates,
      );
      assignStates(VoiceNodeType.Envelope, templateState.envelopes, this.envelopeStates);
      assignStates(VoiceNodeType.LFO, templateState.lfos, this.lfoStates);
      assignStates(VoiceNodeType.Filter, templateState.filters, this.filterStates);
      assignStates(VoiceNodeType.Sampler, templateState.samplers, this.samplerStates);
      assignStates(
        VoiceNodeType.Convolver,
        templateState.convolvers,
        this.convolverStates,
      );
      assignStates(VoiceNodeType.Delay, templateState.delays, this.delayStates);
      assignStates(VoiceNodeType.Chorus, templateState.choruses, this.chorusStates);
      assignStates(VoiceNodeType.Reverb, templateState.reverbs, this.reverbStates);

      if (templateState.noise) {
        this.noiseState = templateState.noise;
      }
      if (templateState.velocity) {
        this.velocityState = templateState.velocity;
      }

      const remappedAssets = new Map<string, AudioAsset>();
      templateState.audioAssets.forEach((asset, assetId) => {
        const parsed = parseAudioAssetId(assetId);
        if (!parsed) return;
        const mappedNodeId = nodeIdRemap.get(parsed.nodeId);
        if (!mappedNodeId) return;
        const newId = createAudioAssetId(parsed.nodeType, mappedNodeId);
        remappedAssets.set(newId, asset);
      });
      this.audioAssets = remappedAssets;

      return true;
    },

    async initializeNewPatchSession(): Promise<void> {
      if (this.currentPatchId && this.currentBank) {
        return;
      }

      const patch = await this.createNewPatchFromTemplate('New Patch');
      if (!patch) {
        console.error('Failed to create initial patch during startup');
        return;
      }

      console.log('Initial patch created:', patch.metadata.id);
    },

    // Helper method to check if connection exists
    hasExistingConnection(fromId: string, toId: string): boolean {
      return (
        this.synthLayout?.voices.some((voice) =>
          voice.connections.some(
            (conn) => conn.fromId === fromId && conn.toId === toId,
          ),
        ) ?? false
      );
    },

    hasMatchingConnection(
      fromId: string,
      toId: string,
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
    convertModulationType(raw: number | string | undefined): WasmModulationType {
      if (raw === undefined) {
        // If the modulation type is missing, default to Additive.
        return WasmModulationType.Additive;
      }
      // Handle numeric values from Rust (0=VCA, 1=Bipolar, 2=Additive)
      if (typeof raw === 'number') {
        switch (raw) {
          case 0:
            return WasmModulationType.VCA;
          case 1:
            return WasmModulationType.Bipolar;
          case 2:
            return WasmModulationType.Additive;
          default:
            console.warn('Unknown numeric modulation type:', raw);
            return WasmModulationType.Additive;
        }
      }
      // Handle string values
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
    // updateSynthLayout(layout: SynthLayout) {
    //   console.log('Updating synth layout with:', layout);

    //   // Validate that we have at least one voice
    //   if (!layout.voices || !Array.isArray(layout.voices) || layout.voices.length === 0) {
    //     console.warn('Received invalid synth layout (no voices).');
    //     return;
    //   }

    //   // Deep clone the layout so we can modify it safely
    //   const layoutClone = JSON.parse(JSON.stringify(layout)) as SynthLayout;

    //   // Process each voice: convert raw connections and raw node arrays
    //   layoutClone.voices = layoutClone.voices.map((voice) => {
    //     // --- Convert Connections ---
    //     if (Array.isArray(voice.connections) && voice.connections.length > 0) {
    //       const firstConn = voice.connections[0]!;
    //       if ('from_id' in firstConn) {

    //         const rawConnections = voice.connections as unknown as RawConnection[];

    //         voice.connections = rawConnections.map((rawConn: RawConnection): NodeConnection => ({
    //           fromId: rawConn.from_id,
    //           toId: rawConn.to_id,
    //           target: rawConn.target as PortId,
    //           amount: rawConn.amount,
    //           modulationTransformation: rawConn.modulation_transform,
    //           modulationType: this.convertModulationType(rawConn.modulation_type),
    //         }));
    //       }
    //     }

    //     // --- Convert Nodes ---
    //     if (Array.isArray(voice.nodes)) {
    //       const nodesByType: { [key in VoiceNodeType]: { id: number; type: VoiceNodeType }[] } = {
    //         [VoiceNodeType.Oscillator]: [],
    //         [VoiceNodeType.WavetableOscillator]: [],
    //         [VoiceNodeType.Filter]: [],
    //         [VoiceNodeType.Envelope]: [],
    //         [VoiceNodeType.LFO]: [],
    //         [VoiceNodeType.Mixer]: [],
    //         [VoiceNodeType.Noise]: [],
    //         [VoiceNodeType.GlobalFrequency]: [],
    //         [VoiceNodeType.GlobalVelocity]: [],
    //         [VoiceNodeType.Convolver]: [],
    //         [VoiceNodeType.Delay]: [],
    //         [VoiceNodeType.GateMixer]: [],
    //         [VoiceNodeType.ArpeggiatorGenerator]: [],
    //         [VoiceNodeType.Chorus]: [],
    //         [VoiceNodeType.Limiter]: [],
    //       };

    //       interface RawNode {
    //         id: number;
    //         node_type: string;
    //       }
    //       const convertNodeType = (raw: string): VoiceNodeType => {
    //         switch (raw) {
    //           case 'analog_oscillator':
    //             return VoiceNodeType.Oscillator;
    //           case 'filtercollection':
    //             return VoiceNodeType.Filter;
    //           case 'envelope':
    //             return VoiceNodeType.Envelope;
    //           case 'lfo':
    //             return VoiceNodeType.LFO;
    //           case 'mixer':
    //             return VoiceNodeType.Mixer;
    //           case 'noise_generator':
    //             return VoiceNodeType.Noise;
    //           case 'global_frequency':
    //             return VoiceNodeType.GlobalFrequency;
    //           case 'global_velocity':
    //             return VoiceNodeType.GlobalVelocity;
    //           case 'wavetable_oscillator':
    //             return VoiceNodeType.WavetableOscillator;
    //           case 'convolver':
    //             return VoiceNodeType.Convolver;
    //           case 'delay':
    //             return VoiceNodeType.Delay;
    //           case 'gatemixer':
    //             return VoiceNodeType.GateMixer;
    //           case 'arpeggiator_generator':
    //             return VoiceNodeType.ArpeggiatorGenerator;
    //           case 'chorus':
    //             return VoiceNodeType.Chorus;
    //           case 'limiter':
    //             return VoiceNodeType.Limiter;
    //           default:
    //             console.warn('$$$ Unknown node type:', raw);
    //             return raw as VoiceNodeType;
    //         }
    //       };

    //       for (const rawNode of voice.nodes as RawNode[]) {
    //         const type = convertNodeType(rawNode.node_type);
    //         nodesByType[type].push({ id: rawNode.id, type });
    //       }
    //       voice.nodes = nodesByType;
    //     }
    //     return voice;
    //   });

    //   // Use the canonical voice (assumed to be voices[0]) as our reference
    //   const canonicalVoice = layoutClone.voices[0];
    //   if (!canonicalVoice || !canonicalVoice.nodes) {
    //     console.warn('Canonical voice or its nodes missing in layout');
    //     return;
    //   }

    //   // Log valid node IDs from the canonical voice
    //   const validIds = new Set<number>();
    //   Object.values(canonicalVoice.nodes).forEach((nodeArray) => {
    //     nodeArray.forEach((node) => validIds.add(node.id));
    //   });
    //   console.log(`Valid node IDs from canonical voice: ${Array.from(validIds).sort().join(', ')}`);

    //   // --- Trigger Vue Reactivity ---
    //   this.synthLayout = { ...layoutClone };

    //   // Initialize default states for all nodes
    //   this.initializeDefaultStates();

    //   // Clear any deletion markers since the WASM layout is now definitive
    //   this.deletedNodeIds.clear();
    //   console.log('--------- LAYOUT UPDATE FINISHED ---------');
    //   console.log('synthLayout:', this.synthLayout);
    // }
    updateSynthLayout(layout: SynthLayout) {
      console.log('Updating synth layout with:', layout);

      const existingNames = new Map<string, string>();
      if (this.synthLayout) {
        this.synthLayout.voices.forEach((voice) => {
          Object.values(voice.nodes).forEach((nodeArray) => {
            nodeArray.forEach((node) => existingNames.set(node.id, node.name));
          });
        });
      }

      // Validate that we have at least one voice
      if (
        !layout.voices ||
        !Array.isArray(layout.voices) ||
        layout.voices.length === 0
      ) {
        console.warn('Received invalid synth layout (no voices).');
        return;
      }

      // Deep clone the layout so we can modify it safely
      const layoutClone = JSON.parse(JSON.stringify(layout)) as SynthLayout;

      // Process each voice: convert raw connections and raw node arrays
      const previousVoiceCount =
        this.synthLayout?.voiceCount ??
        this.synthLayout?.voices.length ??
        0;
      const instrumentVoiceCount = this.currentInstrument?.num_voices ?? 0;

      layoutClone.voices = layoutClone.voices.map((voice) => {
        // Track generated default names so duplicated node types get unique labels
        const defaultNameCounts = new Map<VoiceNodeType, Map<string, number>>();
        const nextDefaultName = (
          type: VoiceNodeType,
          baseName: string,
        ): string => {
          const typeCounts =
            defaultNameCounts.get(type) ?? new Map<string, number>();
          const nextCount = (typeCounts.get(baseName) ?? 0) + 1;
          typeCounts.set(baseName, nextCount);
          defaultNameCounts.set(type, typeCounts);

          return nextCount === 1 ? baseName : `${baseName} ${nextCount}`;
        };

        // --- Convert Connections ---
        if (Array.isArray(voice.connections) && voice.connections.length > 0) {
          const firstConn = voice.connections[0]!;
          // Check if it's in the raw format (snake_case keys) coming from WASM/JSON
          if (
            typeof firstConn === 'object' &&
            firstConn !== null &&
            'from_id' in firstConn
          ) {
            const rawConnections =
              voice.connections as unknown as RawConnection[];
            console.log(
              `updateSynthLayout: Processing ${rawConnections.length} raw connections for voice ${voice.id}`,
            );

            voice.connections = rawConnections.map((rawConn: RawConnection) => {
              const amount =
                typeof rawConn.amount === 'number' && !isNaN(rawConn.amount)
                  ? rawConn.amount
                  : Number(rawConn.amount) || 1.0;

              const targetValue =
                typeof rawConn.target === 'number' && !isNaN(rawConn.target)
                  ? rawConn.target
                  : Number(rawConn.target) || 0;

              const modulationTransformation =
                typeof rawConn.modulation_transform === 'number' &&
                !isNaN(rawConn.modulation_transform)
                  ? rawConn.modulation_transform
                  : ModulationTransformation.None;

              const newNodeConnection: NodeConnection = {
                fromId: String(rawConn.from_id),
                toId: String(rawConn.to_id),
                target: targetValue as PortId,
                amount,
                modulationTransformation,
                modulationType: this.convertModulationType(
                  rawConn.modulation_type,
                ),
              };

              return newNodeConnection;
            });
          } else {
            console.log(
              `updateSynthLayout: Connections for voice ${voice.id} appear to be in correct format already.`,
            );
            voice.connections = voice.connections.map((conn) => ({
              ...conn,
              fromId: String(conn.fromId),
              toId: String(conn.toId),
              target: Number(conn.target) as PortId,
              amount: Number(conn.amount),
              modulationTransformation:
                typeof conn.modulationTransformation === 'number'
                  ? conn.modulationTransformation
                  : ModulationTransformation.None,
            }));
          }
        }

        // --- Convert Nodes ---
        // (Node conversion logic remains the same as before)
        if (Array.isArray(voice.nodes)) {
          // ... existing node conversion logic ...
          const nodesByType: {
            [key in VoiceNodeType]: { id: string; type: VoiceNodeType; name: string }[];
          } = {
            [VoiceNodeType.Oscillator]: [],
            [VoiceNodeType.WavetableOscillator]: [],
            [VoiceNodeType.Filter]: [],
            [VoiceNodeType.Envelope]: [],
            [VoiceNodeType.LFO]: [],
            [VoiceNodeType.Mixer]: [],
            [VoiceNodeType.Noise]: [],
            [VoiceNodeType.Sampler]: [],
            [VoiceNodeType.GlobalFrequency]: [],
            [VoiceNodeType.GlobalVelocity]: [],
            [VoiceNodeType.Convolver]: [],
            [VoiceNodeType.Delay]: [],
            [VoiceNodeType.GateMixer]: [],
            [VoiceNodeType.ArpeggiatorGenerator]: [],
            [VoiceNodeType.Chorus]: [],
            [VoiceNodeType.Limiter]: [],
            [VoiceNodeType.Reverb]: [],
          };

          interface RawNode {
            id: string;
            node_type: string;
            name: string;
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
              case 'sampler':
              case 'Sampler':
                return VoiceNodeType.Sampler;
              case 'convolver':
                return VoiceNodeType.Convolver;
              case 'delay':
                return VoiceNodeType.Delay;
              case 'gatemixer':
                return VoiceNodeType.GateMixer;
              case 'arpeggiator_generator':
                return VoiceNodeType.ArpeggiatorGenerator;
              case 'chorus':
                return VoiceNodeType.Chorus;
              case 'limiter':
                return VoiceNodeType.Limiter;
              case 'freeverb':
                return VoiceNodeType.Reverb;
              default:
                console.warn(
                  '$$$ Unknown node type in updateSynthLayout:',
                  raw,
                );
                return raw as VoiceNodeType; // Fallback, might cause issues
            }
          };

          for (const rawNode of voice.nodes as RawNode[]) {
            const type = convertNodeType(rawNode.node_type);
            const nodeId = String(rawNode.id);
            if (!nodeId) {
              console.error(
                `updateSynthLayout: Invalid node ID "${rawNode.id}" found. Skipping node.`,
              );
              continue;
            }
            const baseName = rawNode.name?.trim() || `${type} ${nodeId}`;
            const nodeName = existingNames.get(nodeId) || nextDefaultName(type, baseName);
            // Check if type is valid before pushing
            if (nodesByType[type]) {
              nodesByType[type].push({ id: nodeId, type, name: nodeName });
            } else {
              console.warn(
                `updateSynthLayout: Node type "${type}" derived from "${rawNode.node_type}" is not tracked in nodesByType. Skipping node.`,
              );
            }
          }
          voice.nodes = nodesByType;
        }
        return voice;
      });

      const canonicalSource = layoutClone.voices[0]
        ? cloneVoiceLayout(layoutClone.voices[0]!)
        : undefined;

      const resolvedVoiceCount =
        layoutClone.voiceCount && layoutClone.voiceCount > 0
          ? layoutClone.voiceCount
          : previousVoiceCount > 0
            ? previousVoiceCount
            : instrumentVoiceCount > 0
              ? instrumentVoiceCount
              : layoutClone.voices.length;

      if (canonicalSource && layoutClone.voices.length !== resolvedVoiceCount) {
        layoutClone.voices = Array.from(
          { length: resolvedVoiceCount },
          (_, index) => {
            const clone = cloneVoiceLayout(canonicalSource);
            clone.id = index;
            return clone;
          },
        );
      } else {
        layoutClone.voices = layoutClone.voices.map((voice, index) => ({
          ...voice,
          id: index,
        }));
      }

      layoutClone.voiceCount = resolvedVoiceCount;
      if (layoutClone.voices[0]) {
        layoutClone.canonicalVoice = cloneVoiceLayout(
          layoutClone.voices[0]!,
        );
      }

      // Use the canonical voice (assumed to be voices[0]) as our reference
      const canonicalVoice = layoutClone.voices[0];
      if (!canonicalVoice || !canonicalVoice.nodes) {
        console.warn('Canonical voice or its nodes missing in layout');
        return;
      }

      // Log valid node IDs from the canonical voice
      const validIds = new Set<string>();
      Object.values(canonicalVoice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => validIds.add(node.id));
      });
      // console.log(`Valid node IDs from canonical voice: ${Array.from(validIds).sort((a, b) => a - b).join(', ')}`);

      // --- Trigger Vue Reactivity ---
      this.synthLayout = { ...layoutClone };

      // Initialize default states for all nodes
      this.initializeDefaultStates();

      // Clear any deletion markers since the WASM layout is now definitive
      this.deletedNodeIds.clear();
      console.log('--------- updateSynthLayout FINISHED ---------');
      // console.log('Processed synthLayout:', this.synthLayout); // Log final result if needed
    },
    getNodeName(nodeId: string): string | undefined {
      const voice = this.synthLayout?.voices[0];
      if (!voice) return undefined;
      for (const type of Object.values(VoiceNodeType)) {
        const node = voice.nodes[type]?.find((n) => n.id === nodeId);
        if (node) return node.name;
      }
      return undefined;
    },
    renameNode(nodeId: string, newName: string) {
      if (!this.synthLayout) return;
      const normalized = newName.trim();
      if (!normalized) return;

      this.synthLayout.voices.forEach((voice) => {
        Object.values(voice.nodes).forEach((nodeArray) => {
          nodeArray.forEach((node) => {
            if (node.id === nodeId) {
              node.name = normalized;
            }
          });
        });
      });

      this.synthLayout = { ...this.synthLayout };
    },
    updateOscillator(nodeId: string, state: OscillatorState) {
      this.oscillatorStates.set(nodeId, state);
      this.currentInstrument?.updateOscillatorState(nodeId, state);
    },

    updateEnvelope(nodeId: string, state: EnvelopeConfig) {
      this.envelopeStates.set(nodeId, state);
      this.currentInstrument?.updateEnvelopeState(nodeId, state);
    },

    updateLfo(nodeId: string, state: LfoState) {
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

    updateSampler(nodeId: string, state: Partial<SamplerState>) {
      const currentState =
        this.samplerStates.get(nodeId) || createDefaultSamplerState(nodeId);
      const mergedState: SamplerState = {
        ...currentState,
        ...state,
        id: nodeId,
      };
      this.samplerStates.set(nodeId, mergedState);
      this.sendSamplerState(nodeId);
    },

    setSamplerSampleInfo(
      nodeId: string,
      info: { sampleLength: number; sampleRate: number; channels: number; fileName?: string },
    ) {
      const currentState =
        this.samplerStates.get(nodeId) || createDefaultSamplerState(nodeId);
      const safeLength = info.sampleLength || currentState.sampleLength;
      const updatedState: SamplerState = {
        ...currentState,
        sampleLength: safeLength,
        sampleRate: info.sampleRate || currentState.sampleRate,
        channels:
          typeof info.channels === 'number'
            ? info.channels
            : currentState.channels,
        loopEnd: safeLength > 0 ? 1 : currentState.loopEnd,
      };
      const nextFileName =
        info.fileName !== undefined ? info.fileName : currentState.fileName;
      if (nextFileName !== undefined) {
        updatedState.fileName = nextFileName;
      }
      this.samplerStates.set(nodeId, updatedState);
      this.sendSamplerState(nodeId);
      void this.fetchSamplerWaveform(nodeId);
    },

    async fetchSamplerWaveform(nodeId: string, maxPoints = 512) {
      if (!this.currentInstrument) return;
      try {
        const waveform = await this.currentInstrument.getSamplerWaveform(
          nodeId,
          maxPoints,
        );
        this.samplerWaveforms.set(nodeId, waveform);
      } catch (err) {
        console.error('Failed to fetch sampler waveform', err);
      }
    },

    buildSamplerUpdatePayload(state: SamplerState) {
      const sampleLength = Math.max(1, state.sampleLength || DEFAULT_SAMPLE_RATE);
      const loopStartNorm = Math.min(Math.max(state.loopStart ?? 0, 0), 1);
      const requestedEnd = Math.min(Math.max(state.loopEnd ?? 1, 0), 1);
      const minDelta = 1 / sampleLength;
      const loopEndNorm =
        requestedEnd <= loopStartNorm + minDelta
          ? Math.min(1, loopStartNorm + minDelta)
          : requestedEnd;

      return {
        frequency: state.frequency,
        gain: state.gain,
        loopMode: state.loopMode,
        loopStart: loopStartNorm * sampleLength,
        loopEnd: loopEndNorm * sampleLength,
        rootNote: state.rootNote,
        triggerMode: state.triggerMode,
        active: state.active,
      };
    },

    sendSamplerState(nodeId: string) {
      if (!this.currentInstrument) return;
      const state = this.samplerStates.get(nodeId);
      if (!state) return;
      const payload = this.buildSamplerUpdatePayload(state);
      this.currentInstrument.updateSamplerState(nodeId, payload);
    },

    debugNodeState() {
      if (!this.synthLayout) return;

      // Get the canonical voice
      const voice = this.synthLayout.voices[0];
      if (!voice) return;

      console.log('Current node state:');

      // For each node type, log the node IDs and their corresponding state
      Object.values(VoiceNodeType).forEach((type) => {
        const nodes = getNodesOfType(voice, type) || [];
        console.log(
          `${type} nodes:`,
          nodes.map((n) => n.id),
        );

        // Check if each node has corresponding state
        switch (type) {
          case VoiceNodeType.Oscillator:
            console.log(
              `${type} states:`,
              Array.from(this.oscillatorStates.keys()),
            );
            break;
          case VoiceNodeType.WavetableOscillator:
            console.log(
              `${type} states:`,
              Array.from(this.wavetableOscillatorStates.keys()),
            );
            break;
          case VoiceNodeType.Envelope:
            console.log(
              `${type} states:`,
              Array.from(this.envelopeStates.keys()),
            );
            break;
          case VoiceNodeType.LFO:
            console.log(`${type} states:`, Array.from(this.lfoStates.keys()));
            break;
          // Add other node types as needed
        }
      });
    },
    updateFilter(nodeId: string, state: FilterState) {
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

    syncCanonicalVoiceWithFirstVoice() {
      if (!this.synthLayout || this.synthLayout.voices.length === 0) {
        return;
      }
      this.synthLayout.canonicalVoice = cloneVoiceLayout(
        this.synthLayout.voices[0]!,
      );
    },

    removeNodeFromLayout(nodeId: string) {
      if (!this.synthLayout) {
        return;
      }

      const updatedVoices = this.synthLayout.voices.map((voice) => {
        const updatedNodes = { ...voice.nodes };

        (Object.keys(updatedNodes) as Array<VoiceNodeType>).forEach((type) => {
          const nodeList = updatedNodes[type] || [];
          const filtered = nodeList.filter((node) => node.id !== nodeId);
          if (filtered.length !== nodeList.length) {
            updatedNodes[type] = filtered;
          }
        });

        const updatedConnections = voice.connections.filter(
          (conn) => conn.fromId !== nodeId && conn.toId !== nodeId,
        );

        return {
          ...voice,
          nodes: updatedNodes,
          connections: updatedConnections,
        };
      });

      this.synthLayout = {
        ...this.synthLayout,
        voices: updatedVoices,
      };
      this.syncCanonicalVoiceWithFirstVoice();
    },

    async processUpdateQueue() {
      if (this.isUpdating) return; // prevent concurrent processing
      this.isUpdating = true;

      while (this.updateQueue.length > 0) {
        const connection = this.updateQueue.shift()!;
        try {
          // Prepare the connection update
          const plainConnection = {
            fromId: String(connection.fromId),
            toId: String(connection.toId),
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
            this.syncCanonicalVoiceWithFirstVoice();
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

    async deleteNodeCleanup(deletedNodeId: string): Promise<void> {
      console.log(`Starting node cleanup for deleted node ${deletedNodeId}`);

      try {
        // Update the layout immediately so serialization doesn't resurrect the node
        this.removeNodeFromLayout(deletedNodeId);

        // Mark node as deleted
        this.deletedNodeIds.add(deletedNodeId);

        // Store the node type for debugging
        const nodeType = this.findNodeById(deletedNodeId)?.type;
        console.log(`Deleted node type: ${nodeType || 'unknown'}`);

        // Simply remove the deleted node's state from all maps
        // With UUIDs, no ID shifting is needed!
        this.oscillatorStates.delete(deletedNodeId);
        this.wavetableOscillatorStates.delete(deletedNodeId);
        this.envelopeStates.delete(deletedNodeId);
        this.lfoStates.delete(deletedNodeId);
        this.filterStates.delete(deletedNodeId);
        this.delayStates.delete(deletedNodeId);
        this.convolverStates.delete(deletedNodeId);
        this.chorusStates.delete(deletedNodeId);
        this.samplerStates.delete(deletedNodeId);
        this.samplerWaveforms.delete(deletedNodeId);
        this.reverbStates.delete(deletedNodeId);

        // Wait for the WebAssembly to complete the deletion
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Force a sync with WebAssembly to get the latest state
        if (this.currentInstrument) {
          const wasmStateJson =
            await this.currentInstrument.getWasmNodeConnections();

          if (wasmStateJson) {
            const wasmState = JSON.parse(wasmStateJson);

            await nextTick(() => {
              // Update the synth layout with the latest WASM state
              this.updateSynthLayout(wasmState);

              // Initialize default states for any new nodes
              this.initializeDefaultStates();

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
      const analogOscillators =
        getNodesOfType(voice, VoiceNodeType.Oscillator) || [];

      console.log(
        `Found ${analogOscillators.length} analog oscillators in layout`,
      );
      console.log(
        `Found ${this.oscillatorStates.size} oscillator states in store`,
      );

      // Check each oscillator node against its stored state
      analogOscillators.forEach((osc) => {
        const state = this.oscillatorStates.get(osc.id);
        if (state) {
          console.log(
            `Oscillator ${osc.id}: waveform=${state.waveform}, gain=${state.gain}`,
          );
        } else {
          console.log(`Oscillator ${osc.id}: NO STATE FOUND`);
        }
      });

      // Check for any orphaned states (states without nodes)
      this.oscillatorStates.forEach((state, id) => {
        const node = analogOscillators.find((n) => n.id === id);
        if (!node) {
          console.log(
            `Orphaned state for oscillator ${id}: waveform=${state.waveform}`,
          );
        }
      });
    },
    // Improved applyPreservedStatesToWasm function
    applyPreservedStatesToWasm() {
      if (!this.currentInstrument) return;

      // Apply analog oscillator states
      // In applyPreservedStatesToWasm
      this.oscillatorStates.forEach((state, nodeId) => {
        console.log(
          'Reapplying analog oscillator state for node',
          nodeId,
          state,
        );
        // Log the specific waveform value to verify it's being passed correctly
        console.log(
          `## Oscillator ${nodeId} waveform value being reapplied: ${state.waveform}`,
        );
        this.currentInstrument?.updateOscillatorState(nodeId, {
          ...state,
          id: nodeId,
          // Explicitly ensure waveform is preserved
          waveform: state.waveform,
        });
      });

      // Apply wavetable oscillator states (with proper type conversion)
      this.wavetableOscillatorStates.forEach((state, nodeId) => {
        console.log(
          'Reapplying wavetable oscillator state for node',
          nodeId,
          state,
        );
        this.currentInstrument?.updateWavetableOscillatorState(nodeId, {
          ...state,
          // Ensure ID is consistent
          id: nodeId,
        });
      });

      // Apply envelope states
      this.envelopeStates.forEach((state, nodeId) => {
        console.log('Reapplying envelope state for node', nodeId, state);
        this.currentInstrument?.updateEnvelopeState(nodeId, {
          ...state,
          id: nodeId,
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
          id: nodeId,
        });
      });

      // Add convolver states
      this.convolverStates.forEach((state, nodeId) => {
        console.log('Reapplying convolver state for node', nodeId, state);
        if (this.currentInstrument?.updateConvolverState) {
          this.currentInstrument.updateConvolverState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });

      // Add delay states
      this.delayStates.forEach((state, nodeId) => {
        console.log('Reapplying delay state for node', nodeId, state);
        if (this.currentInstrument?.updateDelayState) {
          this.currentInstrument.updateDelayState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });

      this.samplerStates.forEach((state, nodeId) => {
        console.log('Reapplying sampler state for node', nodeId, state);
        this.sendSamplerState(nodeId);
      });

      this.chorusStates.forEach((state, nodeId) => {
        console.log('Reapplying chorus state for node', nodeId, state);
        if (this.currentInstrument?.updateChorusState) {
          this.currentInstrument.updateChorusState(nodeId, {
            ...state,
            id: nodeId,
          });
        }
      });
    },
    // Add this method to initialize default states
    initializeDefaultStates() {
      if (!this.synthLayout) return;

      const voice = this.synthLayout.voices[0];
      if (!voice) return;

      // Get the set of valid node IDs from the current layout
      const validNodeIds = new Set<string>();
      Object.values(voice.nodes).forEach((nodeArray) => {
        nodeArray.forEach((node) => validNodeIds.add(node.id));
      });

      // Remove orphaned states for nodes that no longer exist
      console.log('[initializeDefaultStates] Valid node IDs:', Array.from(validNodeIds));
      console.log('[initializeDefaultStates] Current sampler states:', Array.from(this.samplerStates.keys()));

      this.oscillatorStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          console.log('[initializeDefaultStates] Deleting orphaned oscillator:', id);
          this.oscillatorStates.delete(id);
        }
      });
      this.wavetableOscillatorStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          console.log('[initializeDefaultStates] Deleting orphaned wavetable osc:', id);
          this.wavetableOscillatorStates.delete(id);
        }
      });
      this.samplerStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          console.log('[initializeDefaultStates] Deleting orphaned sampler:', id);
          this.samplerStates.delete(id);
          this.samplerWaveforms.delete(id);
        }
      });
      console.log('[initializeDefaultStates] Sampler states after cleanup:', Array.from(this.samplerStates.keys()));
      this.envelopeStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.envelopeStates.delete(id);
        }
      });
      this.lfoStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.lfoStates.delete(id);
        }
      });
      this.filterStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.filterStates.delete(id);
        }
      });
      this.convolverStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.convolverStates.delete(id);
        }
      });
      this.delayStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.delayStates.delete(id);
        }
      });
      this.chorusStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.chorusStates.delete(id);
        }
      });
      this.reverbStates.forEach((_, id) => {
        if (!validNodeIds.has(id)) {
          this.reverbStates.delete(id);
        }
      });

      // Remove orphaned audio assets
      const assetsToRemove: string[] = [];
      this.audioAssets.forEach((_, assetId) => {
        const parsed = parseAudioAssetId(assetId);
        if (parsed && !validNodeIds.has(parsed.nodeId)) {
          assetsToRemove.push(assetId);
        }
      });
      assetsToRemove.forEach((assetId) => {
        this.audioAssets.delete(assetId);
      });

      // Initialize oscillator states
      const analogOscillators =
        getNodesOfType(voice, VoiceNodeType.Oscillator) || [];
      analogOscillators.forEach((osc) => {
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
      const wavetableOscillators =
        getNodesOfType(voice, VoiceNodeType.WavetableOscillator) || [];
      wavetableOscillators.forEach((osc) => {
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

      const samplers = getNodesOfType(voice, VoiceNodeType.Sampler) || [];
      samplers.forEach((sampler) => {
        if (!this.samplerStates.has(sampler.id)) {
          this.samplerStates.set(
            sampler.id,
            createDefaultSamplerState(sampler.id),
          );
        }
      });

      // Initialize envelope states
      const envelopes = getNodesOfType(voice, VoiceNodeType.Envelope) || [];
      envelopes.forEach((env) => {
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
      lfos.forEach((lfo) => {
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
      filters.forEach((filter) => {
        if (!this.filterStates.has(filter.id)) {
          this.filterStates.set(filter.id, {
            id: filter.id,
            cutoff: 20000,
            resonance: 0,
            keytracking: 0,
            comb_frequency: 220,
            comb_dampening: 0.5,
            oversampling: 0,
            gain: 0.5,
            filter_type: FilterType.LowPass,
            filter_slope: FilterSlope.Db12,
            active: true,
          });
        }
      });
    },

    /**
     * Reset the current synth state back to default values for the
     * existing layout and push those defaults into the audio engine.
     *
     * Used when creating a brand new patch so that it starts from a
     * clean, initialized state instead of copying the previous patch.
     */
    resetCurrentStateToDefaults(applyToWasm = true) {
      // Clear all per-node state maps
      this.oscillatorStates = new Map<string, OscillatorState>();
      this.wavetableOscillatorStates = new Map<string, OscillatorState>();
      this.samplerStates = new Map<string, SamplerState>();
      this.samplerWaveforms = new Map<string, Float32Array>();
      this.envelopeStates = new Map<string, EnvelopeConfig>();
      this.convolverStates = new Map<string, ConvolverState>();
      this.delayStates = new Map<string, DelayState>();
      this.filterStates = new Map<string, FilterState>();
      this.lfoStates = new Map<string, LfoState>();
      this.chorusStates = new Map<string, ChorusState>();
      this.reverbStates = new Map<string, ReverbState>();

      // Clear any captured audio assets
      this.audioAssets = new Map<string, AudioAsset>();

      // Reset global noise / velocity to their defaults
      this.noiseState = {
        noiseType: NoiseType.White,
        cutoff: 1.0,
        gain: 1.0,
        is_enabled: false,
      };

      this.velocityState = {
        sensitivity: 1.0,
        randomize: 0.0,
        active: true,
      };

      // Recreate default per-node states for the existing layout
      this.initializeDefaultStates();

      // Apply the freshly initialized states to the audio engine
      if (applyToWasm) {
        this.applyPreservedStatesToWasm();
      }
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

    // ========== PATCH/BANK MANAGEMENT ==========

    /**
     * Save the current synth state as a new patch
     */
    async saveCurrentPatch(
      name: string,
      metadata?: { author?: string; tags?: string[]; description?: string },
    ): Promise<Patch | null> {
      if (!this.synthLayout) {
        console.error('Cannot save patch: no synth layout');
        return null;
      }

      if (!this.currentInstrument) {
        console.error('Cannot save patch: no instrument');
        return null;
      }

      try {
        // Extract audio assets from sampler and convolver nodes
        const samplerIds = getSamplerNodeIds(this.synthLayout);
        const convolverIds = getConvolverNodeIds(this.synthLayout);

        console.log(
          `Extracting audio assets from ${samplerIds.length} samplers and ${convolverIds.length} convolvers`,
        );

        const extractedAssets = await extractAllAudioAssets(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.currentInstrument as any,
          samplerIds,
          convolverIds,
        );

        // Merge with existing audio assets
        const allAssets = new Map([...this.audioAssets, ...extractedAssets]);

        const patch = serializeCurrentPatch(
          name,
          this.synthLayout,
          this.oscillatorStates,
          this.wavetableOscillatorStates,
          this.filterStates,
          this.envelopeStates,
          this.lfoStates,
          this.samplerStates,
          this.convolverStates,
          this.delayStates,
          this.chorusStates,
          this.reverbStates,
          this.noiseState,
          this.velocityState,
          allAssets,
          metadata,
        );

        // Add to current bank if one exists
        if (this.currentBank) {
          this.currentBank = addPatchToBank(this.currentBank, patch);
        } else {
          // Create a new bank with this patch
          this.currentBank = createBank('Default Bank', [patch]);
        }

        this.currentPatchId = patch.metadata.id;
        console.log('Patch saved successfully:', patch.metadata.name);
        return patch;
      } catch (error) {
        console.error('Failed to save patch:', error);
        return null;
      }
    },

    /**
     * Overwrite the current patch with the current synth state.
     * Does not create a new patch entry in the bank.
     */
    async updateCurrentPatch(
      name?: string,
      metadata?: { author?: string; tags?: string[]; description?: string },
    ): Promise<Patch | null> {
      if (!this.synthLayout) {
        console.error('Cannot update patch: no synth layout');
        return null;
      }

      if (!this.currentInstrument) {
        console.error('Cannot update patch: no instrument');
        return null;
      }

      if (!this.currentBank || !this.currentPatchId) {
        console.error('Cannot update patch: no current patch selected');
        return null;
      }

      const existingPatch = this.currentBank.patches.find(
        (p) => p.metadata.id === this.currentPatchId,
      );

      if (!existingPatch) {
        console.error('Cannot update patch: current patch not found in bank');
        return null;
      }

      try {
        // Extract audio assets from sampler and convolver nodes
        const samplerIds = getSamplerNodeIds(this.synthLayout);
        const convolverIds = getConvolverNodeIds(this.synthLayout);

        console.log(
          `Extracting audio assets from ${samplerIds.length} samplers and ${convolverIds.length} convolvers`,
        );

        const extractedAssets = await extractAllAudioAssets(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.currentInstrument as any,
          samplerIds,
          convolverIds,
        );

        // Merge with existing audio assets
        const allAssets = new Map([...this.audioAssets, ...extractedAssets]);

        const existingMetadata = existingPatch.metadata;
        const finalName = name?.trim() || existingMetadata.name;
        const now = Date.now();
        const mergedMetadata: Partial<PatchMetadata> = {
          ...existingMetadata,
          name: finalName,
          modified: now,
          ...(metadata || {}),
        };

        const patch = serializeCurrentPatch(
          finalName,
          this.synthLayout,
          this.oscillatorStates,
          this.wavetableOscillatorStates,
          this.filterStates,
          this.envelopeStates,
          this.lfoStates,
          this.samplerStates,
          this.convolverStates,
          this.delayStates,
          this.chorusStates,
          this.reverbStates,
          this.noiseState,
          this.velocityState,
          allAssets,
          mergedMetadata,
        );

        this.currentBank = updatePatchInBank(this.currentBank, patch);
        this.currentPatchId = patch.metadata.id;
        console.log('Patch updated successfully:', patch.metadata.name);
        return patch;
      } catch (error) {
        console.error('Failed to update patch:', error);
        return null;
      }
    },

    /**
     * Load a patch and apply it to the synth
     */
    async loadPatch(patchId: string): Promise<boolean> {
      if (!this.currentBank) {
        console.error('Cannot load patch: no bank loaded');
        return false;
      }

      const patch = this.currentBank.patches.find(
        (p) => p.metadata.id === patchId,
      );
      if (!patch) {
        console.error('Patch not found:', patchId);
        return false;
      }

      const success = await this.applyPatchObject(patch);
      if (success) {
        console.log('Patch loaded successfully:', patch.metadata.name);
      }
      return success;
    },

    /**
     * Delete a patch from the current bank
     */
    deletePatch(patchId: string): boolean {
      if (!this.currentBank) {
        console.error('Cannot delete patch: no bank loaded');
        return false;
      }

      this.currentBank = removePatchFromBank(this.currentBank, patchId);

      if (this.currentPatchId === patchId) {
        this.currentPatchId = null;
      }

      console.log('Patch deleted:', patchId);
      return true;
    },

    /**
     * Create a new empty bank
     */
    createNewBank(name: string): Bank {
      this.currentBank = createBank(name);
      this.currentPatchId = null;
      console.log('New bank created:', name);
      return this.currentBank;
    },

    /**
     * Export the current patch as JSON string
     */
    exportCurrentPatchAsJSON(): string | null {
      if (!this.currentPatchId || !this.currentBank) {
        console.error('No current patch to export');
        return null;
      }

      const patch = this.currentBank.patches.find(
        (p) => p.metadata.id === this.currentPatchId,
      );
      if (!patch) {
        console.error('Current patch not found');
        return null;
      }

      return exportPatchToJSON(patch);
    },

    /**
     * Export the current bank as JSON string
     */
    exportCurrentBankAsJSON(): string | null {
      if (!this.currentBank) {
        console.error('No bank to export');
        return null;
      }

      return exportBankToJSON(this.currentBank);
    },

    /**
     * Import a patch from JSON string
     */
    async importPatchFromJSON(json: string): Promise<boolean> {
      const result = importPatchFromJSON(json);

      if (!result.validation.valid) {
        console.error(
          'Patch validation failed:',
          result.validation.errors?.join(', '),
        );
        return false;
      }

      if (result.validation.warnings) {
        console.warn('Patch import warnings:', result.validation.warnings);
      }

      if (!result.patch) {
        console.error('No patch in import result');
        return false;
      }

      // Add to current bank or create new one
      if (this.currentBank) {
        this.currentBank = addPatchToBank(this.currentBank, result.patch);
      } else {
        this.currentBank = createBank('Imported Patches', [result.patch]);
      }

      console.log('Patch imported successfully:', result.patch.metadata.name);

      // Optionally auto-load the imported patch
      return await this.loadPatch(result.patch.metadata.id);
    },

    /**
     * Import a bank from JSON string
     */
    async importBankFromJSON(json: string): Promise<boolean> {
      const result = importBankFromJSON(json);

      if (!result.validation.valid) {
        console.error(
          'Bank validation failed:',
          result.validation.errors?.join(', '),
        );
        return false;
      }

      if (result.validation.warnings) {
        console.warn('Bank import warnings:', result.validation.warnings);
      }

      if (!result.bank) {
        console.error('No bank in import result');
        return false;
      }

      this.currentBank = result.bank;
      this.currentPatchId = null;

      console.log(
        `Bank imported successfully: ${result.bank.metadata.name} with ${result.bank.patches.length} patches`,
      );
      return true;
    },

    /**
     * Restore audio assets (samples, impulses) from the current patch
     */
    async restoreAudioAssets(): Promise<void> {
      if (!this.currentInstrument || this.audioAssets.size === 0) {
        return;
      }

      // Import audio assets for each asset
      for (const [assetId, asset] of this.audioAssets.entries()) {
        try {
          // Parse the asset ID to get node type and ID
          const parsed = parseAudioAssetId(assetId);
          if (!parsed) continue;

          const { nodeType, nodeId } = parsed;

          // Decode base64 to binary
          const binaryData = atob(asset.base64Data);
          const bytes = new Uint8Array(binaryData.length);
          for (let i = 0; i < binaryData.length; i++) {
            bytes[i] = binaryData.charCodeAt(i);
          }

          // Determine asset type and import accordingly
          if (nodeType === 'sample') {
            // Import sample for sampler node
            await this.currentInstrument.importSampleData(nodeId, bytes);
            console.log(`Restored sample for sampler node ${nodeId}`);
          } else if (nodeType === 'impulse_response') {
            // Import impulse response for convolver node
            await this.currentInstrument.importImpulseWaveformData(
              nodeId,
              bytes,
            );
            console.log(
              `Restored impulse response for convolver node ${nodeId}`,
            );
          } else if (nodeType === 'wavetable') {
            // Import wavetable data
            await this.currentInstrument.importWavetableData(nodeId, bytes);
            console.log(`Restored wavetable for node ${nodeId}`);
          }
        } catch (error) {
          console.error(`Failed to restore audio asset ${assetId}:`, error);
        }
      }
    },

    /**
     * Get all patches in the current bank
     */
    getAllPatches(): Patch[] {
      return this.currentBank?.patches || [];
    },

    /**
     * Get the current patch
     */
    getCurrentPatch(): Patch | null {
      if (!this.currentPatchId || !this.currentBank) {
        return null;
      }

      return (
        this.currentBank.patches.find(
          (p) => p.metadata.id === this.currentPatchId,
        ) || null
      );
    },
  },
});

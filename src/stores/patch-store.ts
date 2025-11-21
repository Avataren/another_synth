import { defineStore } from 'pinia';
import { nextTick } from 'vue';
import type {
  AudioAsset,
  Bank,
  Patch,
  PatchMetadata,
} from 'src/audio/types/preset-types';
import {
  addPatchToBank,
  createBank,
  exportBankToJSON,
  importBankFromJSON,
  removePatchFromBank,
  updatePatchInBank,
} from 'src/audio/serialization/bank-serializer';
import {
  deserializePatch,
  exportPatchToJSON,
  importPatchFromJSON,
  serializeCurrentPatch,
  createAudioAssetId,
  parseAudioAssetId,
} from 'src/audio/serialization/patch-serializer';
import {
  extractAllAudioAssets,
  getConvolverNodeIds,
  getSamplerNodeIds,
} from 'src/audio/serialization/audio-asset-extractor';
import { createDefaultPatchMetadata } from 'src/audio/types/preset-types';
import { useInstrumentStore } from './instrument-store';
import { useLayoutStore } from './layout-store';
import { useNodeStateStore } from './node-state-store';
import { useAssetStore } from './asset-store';
import type InstrumentV2 from 'src/audio/instrument-v2';
import { VoiceNodeType, getNodesOfType, cloneVoiceLayout, type SynthLayout, type ConvolverState } from 'src/audio/types/synth-layout';
import { normalizePatchCategory } from 'src/utils/patch-category';

/**
 * Deep clones a patch WITHOUT changing its ID
 * Used for applying templates and restoring patches
 */
const clonePatch = (patch: Patch): Patch =>
  JSON.parse(JSON.stringify(patch)) as Patch;

/**
 * Clones a patch and generates a NEW unique ID
 * Used when duplicating/cloning patches for the user
 */
const clonePatchWithNewId = (patch: Patch, namePrefix?: string): Patch => {
  const cloned = clonePatch(patch);
  const newName = namePrefix
    ? `${namePrefix} ${patch.metadata.name}`
    : patch.metadata.name;
  cloned.metadata = {
    ...cloned.metadata,
    ...createDefaultPatchMetadata(newName, cloned.metadata.category),
  };
  return cloned;
};

type PatchMetadataUpdates = {
  author?: string;
  tags?: string[];
  description?: string;
  category?: string | undefined;
};

const sanitizeMetadataUpdates = (
  updates?: PatchMetadataUpdates,
): PatchMetadataUpdates | undefined => {
  if (!updates) {
    return undefined;
  }

  const normalizedCategory = normalizePatchCategory(updates.category);
  return {
    ...updates,
    category: normalizedCategory,
  };
};

export const usePatchStore = defineStore('patchStore', {
  state: () => ({
    currentBank: null as Bank | null,
    currentPatchId: null as string | null,
    defaultPatchTemplate: null as Patch | null,
    defaultPatchLoadAttempted: false,
    isLoadingPatch: false,
  }),
  getters: {
    currentPatch(state): Patch | null {
      if (!state.currentPatchId || !state.currentBank) {
        return null;
      }
      return (
        state.currentBank.patches.find(
          (p) => p.metadata.id === state.currentPatchId,
        ) || null
      );
    },
  },
  actions: {
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

        this.currentBank = result.bank;
        const firstPatch = result.bank.patches[0];
        if (firstPatch) {
          await this.applyPatchObject(firstPatch);
        }
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
      const instrumentStore = useInstrumentStore();
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const assetStore = useAssetStore();

      try {
        const instrumentReady = await instrumentStore.waitForInstrumentReady();
        if (!instrumentReady) {
          console.warn('Cannot apply patch because instrument is not ready');
          return false;
        }

        const deserialized = deserializePatch(patch);
        this.isLoadingPatch = true;

        // DEBUG: Check if names are preserved in deserialized layout
        console.log('[Patch Store] Deserialized layout voices:', deserialized.layout.voices.length);
        if (deserialized.layout.voices[0]) {
          const firstVoice = deserialized.layout.voices[0];
          console.log('[Patch Store] First voice envelope nodes:', firstVoice.nodes.envelope);
        }

        // Update layout store FIRST before sending to WASM
        // This ensures custom node names are in the store when WASM posts back its layout
        layoutStore.updateSynthLayout(deserialized.layout);
        nodeStateStore.assignStatesFromPatch(deserialized);
        assetStore.setAudioAssets(deserialized.audioAssets);

        // Now send to WASM (may trigger immediate layout update callback)
        instrumentStore.currentInstrument?.loadPatch(patch);

        if (options?.setCurrentPatchId !== false) {
          this.currentPatchId = patch.metadata.id;
        }

        await assetStore.restoreAudioAssets(instrumentStore.currentInstrument as InstrumentV2 | null);

        // Regenerate convolvers with procedural generator params
        await this.restoreGeneratedConvolvers(deserialized.convolvers, instrumentStore.currentInstrument as InstrumentV2 | null);

        this.isLoadingPatch = false;
        return true;
      } catch (error) {
        console.error('Failed to apply patch:', error);
        this.isLoadingPatch = false;
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
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const instrumentStore = useInstrumentStore();
      const layoutReady = await layoutStore.waitForSynthLayout();
      if (!layoutReady) {
        console.warn('Cannot prepare new patch: synth layout not ready');
        return false;
      }
      await instrumentStore.waitForInstrumentReady();

      nodeStateStore.resetCurrentStateToDefaults(false);

      const template = await this.fetchDefaultPatchTemplate();
      if (template) {
        const patchInstance = clonePatch(template);
        const applied = await this.applyPatchObject(patchInstance, {
          setCurrentPatchId: false,
        });
        if (applied) {
          await nextTick(() => {
            nodeStateStore.applyPreservedStatesToWasm();
            void useAssetStore().restoreAudioAssets(
              instrumentStore.currentInstrument as InstrumentV2 | null,
            );
          });
          return true;
        }
      }

      nodeStateStore.applyPreservedStatesToWasm();
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
          return patchInstance;
        }
      }

      const prepared = await this.prepareStateForNewPatch();
      if (!prepared) {
        console.warn('Unable to prepare synth state for new patch');
        return null;
      }

      return await this.saveCurrentPatch(targetName);
    },
    applyTemplateToCurrentLayout(template: Patch): boolean {
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      if (!layoutStore.synthLayout) {
        console.warn('Cannot apply template: synth layout missing');
        return false;
      }

      const canonicalVoice = layoutStore.synthLayout.voices[0];
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
        const orderedTemplates = Array.from(templateMap.entries()).sort(
          ([a], [b]) => a.localeCompare(b),
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
        nodeStateStore.oscillatorStates,
      );
      assignStates(
        VoiceNodeType.WavetableOscillator,
        templateState.wavetableOscillators,
        nodeStateStore.wavetableOscillatorStates,
      );
      assignStates(
        VoiceNodeType.Envelope,
        templateState.envelopes,
        nodeStateStore.envelopeStates,
      );
      assignStates(
        VoiceNodeType.LFO,
        templateState.lfos,
        nodeStateStore.lfoStates,
      );
      assignStates(
        VoiceNodeType.Filter,
        templateState.filters,
        nodeStateStore.filterStates,
      );
      assignStates(
        VoiceNodeType.Sampler,
        templateState.samplers,
        nodeStateStore.samplerStates,
      );
      assignStates(
        VoiceNodeType.Convolver,
        templateState.convolvers,
        nodeStateStore.convolverStates,
      );
      assignStates(
        VoiceNodeType.Delay,
        templateState.delays,
        nodeStateStore.delayStates,
      );
      assignStates(
        VoiceNodeType.Chorus,
        templateState.choruses,
        nodeStateStore.chorusStates,
      );
      assignStates(
        VoiceNodeType.Reverb,
        templateState.reverbs,
        nodeStateStore.reverbStates,
      );

      if (templateState.noise) {
        nodeStateStore.noiseState = templateState.noise;
      }
      if (templateState.velocity) {
        nodeStateStore.velocityState = templateState.velocity;
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
      useAssetStore().setAudioAssets(remappedAssets);

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
    },
    async saveCurrentPatch(
      name: string,
      metadata?: PatchMetadataUpdates,
    ): Promise<Patch | null> {
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const assetStore = useAssetStore();
      const instrumentStore = useInstrumentStore();
      if (!layoutStore.synthLayout) {
        console.error('Cannot save patch: no synth layout');
        return null;
      }

      if (!instrumentStore.currentInstrument) {
        console.error('Cannot save patch: no instrument');
        return null;
      }

      try {
        const samplerIds = getSamplerNodeIds(layoutStore.synthLayout);
        const convolverIds = getConvolverNodeIds(layoutStore.synthLayout);

        if (!instrumentStore.currentInstrument) {
          console.warn('Cannot extract audio assets: instrument not ready');
          return null;
        }

        const extractedAssets = await extractAllAudioAssets(
          instrumentStore.currentInstrument as InstrumentV2,
          samplerIds,
          convolverIds,
          nodeStateStore.convolverStates,
        );

        const allAssets = new Map([
          ...assetStore.audioAssets,
          ...extractedAssets,
        ]);

        const metadataPayload = sanitizeMetadataUpdates(metadata);

        const patch = serializeCurrentPatch(
          name,
          layoutStore.synthLayout,
          nodeStateStore.oscillatorStates,
          nodeStateStore.wavetableOscillatorStates,
          nodeStateStore.filterStates,
          nodeStateStore.envelopeStates,
          nodeStateStore.lfoStates,
          nodeStateStore.samplerStates,
          nodeStateStore.glideStates,
          nodeStateStore.convolverStates,
          nodeStateStore.delayStates,
          nodeStateStore.chorusStates,
          nodeStateStore.reverbStates,
          nodeStateStore.noiseState,
          nodeStateStore.velocityState,
          allAssets,
          metadataPayload,
        );

        if (this.currentBank) {
          this.currentBank = addPatchToBank(this.currentBank, patch);
        } else {
          this.currentBank = createBank('Default Bank', [patch]);
        }

        this.currentPatchId = patch.metadata.id;
        return patch;
      } catch (error) {
        console.error('Failed to save patch:', error);
        return null;
      }
    },
    async updateCurrentPatch(
      name?: string,
      metadata?: PatchMetadataUpdates,
    ): Promise<Patch | null> {
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const assetStore = useAssetStore();
      const instrumentStore = useInstrumentStore();
      if (!layoutStore.synthLayout) {
        console.error('Cannot update patch: no synth layout');
        return null;
      }

      if (!instrumentStore.currentInstrument) {
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
        const samplerIds = getSamplerNodeIds(layoutStore.synthLayout);
        const convolverIds = getConvolverNodeIds(layoutStore.synthLayout);

        if (!instrumentStore.currentInstrument) {
          console.warn('Cannot extract audio assets: instrument not ready');
          return null;
        }

        const extractedAssets = await extractAllAudioAssets(
          instrumentStore.currentInstrument as InstrumentV2,
          samplerIds,
          convolverIds,
          nodeStateStore.convolverStates,
        );

        const allAssets = new Map([
          ...assetStore.audioAssets,
          ...extractedAssets,
        ]);

        const metadataPayload = sanitizeMetadataUpdates(metadata);
        const existingMetadata = existingPatch.metadata;
        const finalName = name?.trim() || existingMetadata.name;
        const now = Date.now();
        const mergedMetadata: Partial<PatchMetadata> = {
          ...existingMetadata,
          name: finalName,
          modified: now,
          ...(metadataPayload || {}),
        };

        const patch = serializeCurrentPatch(
          finalName,
          layoutStore.synthLayout,
          nodeStateStore.oscillatorStates,
          nodeStateStore.wavetableOscillatorStates,
          nodeStateStore.filterStates,
          nodeStateStore.envelopeStates,
          nodeStateStore.lfoStates,
          nodeStateStore.samplerStates,
          nodeStateStore.glideStates,
          nodeStateStore.convolverStates,
          nodeStateStore.delayStates,
          nodeStateStore.chorusStates,
          nodeStateStore.reverbStates,
          nodeStateStore.noiseState,
          nodeStateStore.velocityState,
          allAssets,
          mergedMetadata,
        );

        this.currentBank = updatePatchInBank(this.currentBank, patch);
        this.currentPatchId = patch.metadata.id;
        return patch;
      } catch (error) {
        console.error('Failed to update patch:', error);
        return null;
      }
    },
    async loadPatch(patchId: string): Promise<boolean> {
      if (!this.currentBank) {
        console.error('Cannot load patch: no bank loaded');
        return false;
      }

      const patch = this.currentBank.patches.find(
        (p) => p.metadata.id === patchId,
      );
      if (!patch) {
        console.error('Patch not found in bank:', patchId);
        return false;
      }

      return await this.applyPatchObject(patch);
    },
    deletePatch(patchId: string): boolean {
      if (!this.currentBank) {
        console.error('Cannot delete patch: no bank loaded');
        return false;
      }

      this.currentBank = removePatchFromBank(this.currentBank, patchId);

      if (this.currentPatchId === patchId) {
        this.currentPatchId = null;
      }

      return true;
    },
    async cloneCurrentPatch(namePrefix = 'Cloned'): Promise<Patch | null> {
      if (!this.currentPatchId || !this.currentBank) {
        console.error('Cannot clone patch: no current patch');
        return null;
      }

      const currentPatch = this.currentBank.patches.find(
        (p) => p.metadata.id === this.currentPatchId,
      );
      if (!currentPatch) {
        console.error('Current patch not found in bank');
        return null;
      }

      // Clone with a new unique ID and prefixed name
      const clonedPatch = clonePatchWithNewId(currentPatch, namePrefix);

      // Add to bank
      this.currentBank = addPatchToBank(this.currentBank, clonedPatch);

      // Set as current patch
      this.currentPatchId = clonedPatch.metadata.id;

      return clonedPatch;
    },
    createNewBank(name: string): Bank {
      this.currentBank = createBank(name);
      this.currentPatchId = null;
      return this.currentBank;
    },
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
    exportCurrentBankAsJSON(): string | null {
      if (!this.currentBank) {
        console.error('No bank to export');
        return null;
      }

      return exportBankToJSON(this.currentBank);
    },
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

      if (this.currentBank) {
        this.currentBank = addPatchToBank(this.currentBank, result.patch);
      } else {
        this.currentBank = createBank('Imported Patches', [result.patch]);
      }

      return await this.loadPatch(result.patch.metadata.id);
    },
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
      return true;
    },
    async restoreGeneratedConvolvers(
      convolvers: Map<string, ConvolverState>,
      instrument: InstrumentV2 | null,
    ): Promise<void> {
      if (!instrument) return;

      for (const [nodeId, state] of convolvers.entries()) {
        if (state.generator) {
          console.log(
            `Regenerating ${state.generator.type} reverb for convolver ${nodeId}`,
            state.generator,
          );

          try {
            if (state.generator.type === 'hall') {
              await instrument.generateHallReverb(
                nodeId,
                state.generator.decayTime,
                state.generator.size, // roomSize
              );
            } else if (state.generator.type === 'plate') {
              await instrument.generatePlateReverb(
                nodeId,
                state.generator.decayTime,
                state.generator.size, // diffusion
              );
            }

            // Update wet mix and active state after generation
            if (instrument.updateConvolverState) {
              instrument.updateConvolverState(nodeId, {
                id: nodeId,
                wetMix: state.wetMix,
                active: state.active,
                generator: state.generator, // Preserve generator params
              });
            }
          } catch (err) {
            console.error(
              `Failed to regenerate ${state.generator.type} reverb for convolver ${nodeId}:`,
              err,
            );
          }
        }
      }
    },
    async setVoiceCount(newCount: number): Promise<boolean> {
      const layoutStore = useLayoutStore();
      const nodeStateStore = useNodeStateStore();
      const assetStore = useAssetStore();
      const instrumentStore = useInstrumentStore();

      if (!layoutStore.synthLayout) {
        console.warn('Cannot set voice count: synth layout not ready');
        return false;
      }

      const clamped = Math.min(8, Math.max(1, Math.round(newCount)));
      const canonical =
        layoutStore.synthLayout.canonicalVoice ??
        layoutStore.synthLayout.voices?.[0];
      if (!canonical) {
        console.warn('Cannot set voice count: no canonical voice available');
        return false;
      }

      const canonicalClone = cloneVoiceLayout(canonical);
      const updatedLayout: SynthLayout = {
        ...layoutStore.synthLayout,
        voiceCount: clamped,
        canonicalVoice: cloneVoiceLayout(canonicalClone),
        voices: Array.from({ length: clamped }, (_, index) => {
          const clone = cloneVoiceLayout(canonicalClone);
          clone.id = index;
          return clone;
        }),
      };

      // Update layout store immediately so UI reflects the selection
      layoutStore.updateSynthLayout(updatedLayout);

      // Build a fresh patch from current state with the new voice count
      const samplerIds = getSamplerNodeIds(updatedLayout);
      const convolverIds = getConvolverNodeIds(updatedLayout);

      let extractedAssets = new Map<string, AudioAsset>();
      if (instrumentStore.currentInstrument) {
        extractedAssets = await extractAllAudioAssets(
          instrumentStore.currentInstrument as InstrumentV2,
          samplerIds,
          convolverIds,
          nodeStateStore.convolverStates,
        );
      }

      const allAssets = new Map([
        ...assetStore.audioAssets,
        ...extractedAssets,
      ]);

      const existingMetadata = this.currentPatch?.metadata;
      const patchName = existingMetadata?.name || 'Patch';

      const patch = serializeCurrentPatch(
        patchName,
        updatedLayout,
        nodeStateStore.oscillatorStates,
        nodeStateStore.wavetableOscillatorStates,
        nodeStateStore.filterStates,
        nodeStateStore.envelopeStates,
        nodeStateStore.lfoStates,
        nodeStateStore.samplerStates,
        nodeStateStore.glideStates,
        nodeStateStore.convolverStates,
        nodeStateStore.delayStates,
        nodeStateStore.chorusStates,
        nodeStateStore.reverbStates,
        nodeStateStore.noiseState,
        nodeStateStore.velocityState,
        allAssets,
        existingMetadata ? { ...existingMetadata } : undefined,
      );

      // Reapply the freshly serialized patch so the engine rebuilds voices
      return await this.applyPatchObject(patch);
    },
  },
});

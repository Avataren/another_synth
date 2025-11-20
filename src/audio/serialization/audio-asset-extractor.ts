// src/audio/serialization/audio-asset-extractor.ts
import type { AudioAsset } from '../types/preset-types';
import { AudioAssetType as AssetType } from '../types/preset-types';
import { encodeFloat32ArrayToBase64 } from './audio-asset-encoder';
import type InstrumentV2 from '../instrument-v2';
import type { SynthLayout, ConvolverState } from '../types/synth-layout';

/**
 * Extracts all audio assets from sampler nodes
 */
export async function extractSamplerAudioAssets(
  instrument: InstrumentV2,
  samplerNodeIds: string[],
): Promise<Map<string, AudioAsset>> {
  const assets = new Map<string, AudioAsset>();

  for (const nodeId of samplerNodeIds) {
    try {
      // Export the raw sample data with metadata
      const sampleData = await instrument.exportSamplerData(nodeId);

      if (sampleData.samples && sampleData.samples.length > 0) {
        // Use the actual metadata from the sampler
        const asset = encodeFloat32ArrayToBase64(
          sampleData.samples,
          sampleData.sampleRate,
          sampleData.channels,
          AssetType.Sample,
          nodeId,
          undefined, // fileName can be added from sampler state if stored
          sampleData.rootNote,
        );

        assets.set(asset.id, asset);
        console.log(
          `Extracted sample for sampler node ${nodeId}: ${sampleData.channels}ch @ ${sampleData.sampleRate}Hz, root note ${sampleData.rootNote}`,
        );
      }
    } catch (error) {
      console.error(`Failed to extract sample from node ${nodeId}:`, error);
    }
  }

  return assets;
}

/**
 * Extracts all audio assets from convolver nodes
 * Skips procedurally-generated impulse responses (hall/plate reverbs)
 * as those are reconstructed from parameters
 */
export async function extractConvolverAudioAssets(
  instrument: InstrumentV2,
  convolverNodeIds: string[],
  convolverStates: Map<string, ConvolverState>,
): Promise<Map<string, AudioAsset>> {
  const assets = new Map<string, AudioAsset>();

  for (const nodeId of convolverNodeIds) {
    try {
      // Check if this is a procedurally-generated convolver
      const state = convolverStates.get(nodeId);
      if (state?.generator) {
        console.log(
          `Skipping binary extraction for ${state.generator.type} reverb (node ${nodeId}) - will be regenerated from parameters`,
        );
        continue; // Don't save binary data for generated impulses
      }

      // Export the raw impulse response data with metadata for user-uploaded impulses
      const convolverData = await instrument.exportConvolverData(nodeId);

      if (convolverData.samples && convolverData.samples.length > 0) {
        // Use the actual metadata from the convolver
        const asset = encodeFloat32ArrayToBase64(
          convolverData.samples,
          convolverData.sampleRate,
          convolverData.channels,
          AssetType.ImpulseResponse,
          nodeId,
          undefined, // fileName can be added from convolver state if stored
          undefined, // rootNote not applicable for impulse responses
        );

        assets.set(asset.id, asset);
        console.log(
          `Extracted custom impulse response for convolver node ${nodeId}: ${convolverData.channels}ch @ ${convolverData.sampleRate}Hz`,
        );
      }
    } catch (error) {
      console.error(
        `Failed to extract impulse from convolver ${nodeId}:`,
        error,
      );
    }
  }

  return assets;
}

/**
 * Extracts all audio assets from the current synth state
 */
export async function extractAllAudioAssets(
  instrument: InstrumentV2,
  samplerNodeIds: string[],
  convolverNodeIds: string[],
  convolverStates: Map<string, ConvolverState>,
): Promise<Map<string, AudioAsset>> {
  const allAssets = new Map<string, AudioAsset>();

  // Extract sampler assets
  const samplerAssets = await extractSamplerAudioAssets(
    instrument,
    samplerNodeIds,
  );
  samplerAssets.forEach((asset, id) => allAssets.set(id, asset));

  // Extract convolver assets (skips procedurally-generated ones)
  const convolverAssets = await extractConvolverAudioAssets(
    instrument,
    convolverNodeIds,
    convolverStates,
  );
  convolverAssets.forEach((asset, id) => allAssets.set(id, asset));

  return allAssets;
}

/**
 * Helper to get all sampler node IDs from a synth layout
 */
export function getSamplerNodeIds(synthLayout: SynthLayout): string[] {
  const nodeIds: string[] = [];

  if (!synthLayout || !synthLayout.voices) {
    return nodeIds;
  }

  for (const voice of synthLayout.voices) {
    if (voice.nodes && voice.nodes.sampler) {
      for (const node of voice.nodes.sampler) {
        nodeIds.push(node.id);
      }
    }
  }

  return nodeIds;
}

/**
 * Helper to get all convolver node IDs from a synth layout
 */
export function getConvolverNodeIds(synthLayout: SynthLayout): string[] {
  const nodeIds: string[] = [];

  if (!synthLayout || !synthLayout.voices) {
    return nodeIds;
  }

  for (const voice of synthLayout.voices) {
    if (voice.nodes && voice.nodes.convolver) {
      for (const node of voice.nodes.convolver) {
        nodeIds.push(node.id);
      }
    }
  }

  return nodeIds;
}

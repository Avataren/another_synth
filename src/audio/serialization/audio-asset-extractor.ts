// src/audio/serialization/audio-asset-extractor.ts
import type { AudioAsset } from '../types/preset-types';
import { AudioAssetType as AssetType } from '../types/preset-types';
import { encodeFloat32ArrayToBase64 } from './audio-asset-encoder';
import type Instrument from '../instrument';
import type { SynthLayout } from '../types/synth-layout';

/**
 * Extracts all audio assets from sampler nodes
 */
export async function extractSamplerAudioAssets(
  instrument: Instrument,
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
 */
export async function extractConvolverAudioAssets(
  instrument: Instrument,
  convolverNodeIds: string[],
): Promise<Map<string, AudioAsset>> {
  const assets = new Map<string, AudioAsset>();

  for (const nodeId of convolverNodeIds) {
    try {
      // Export the raw impulse response data with metadata
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
          `Extracted impulse response for convolver node ${nodeId}: ${convolverData.channels}ch @ ${convolverData.sampleRate}Hz`,
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
  instrument: Instrument,
  samplerNodeIds: string[],
  convolverNodeIds: string[],
): Promise<Map<string, AudioAsset>> {
  const allAssets = new Map<string, AudioAsset>();

  // Extract sampler assets
  const samplerAssets = await extractSamplerAudioAssets(
    instrument,
    samplerNodeIds,
  );
  samplerAssets.forEach((asset, id) => allAssets.set(id, asset));

  // Extract convolver assets
  const convolverAssets = await extractConvolverAudioAssets(
    instrument,
    convolverNodeIds,
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

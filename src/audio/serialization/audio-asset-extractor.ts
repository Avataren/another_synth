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
  samplerNodeIds: number[],
): Promise<Map<string, AudioAsset>> {
  const assets = new Map<string, AudioAsset>();

  for (const nodeId of samplerNodeIds) {
    try {
      // Get the sampler waveform data
      const waveform = await instrument.getSamplerWaveform(nodeId, -1); // -1 = get full waveform

      if (waveform && waveform.length > 0) {
        // Get sampler state to retrieve metadata
        // Note: This would need to be passed in or retrieved from store
        // For now, we'll use placeholder values
        const sampleRate = 44100; // Default, should come from sampler state
        const channels = 1; // Default, should come from sampler state
        const rootNote = 60; // Default C4

        const asset = encodeFloat32ArrayToBase64(
          waveform,
          sampleRate,
          channels,
          AssetType.Sample,
          nodeId,
          undefined, // fileName can be added from sampler state
          rootNote,
        );

        assets.set(asset.id, asset);
        console.log(`Extracted sample for sampler node ${nodeId}`);
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
  convolverNodeIds: number[],
): Promise<Map<string, AudioAsset>> {
  const assets = new Map<string, AudioAsset>();

  for (const nodeId of convolverNodeIds) {
    try {
      // Get the convolver impulse response data
      // Note: You may need to add a method to Instrument to retrieve this
      // const impulseData = await instrument.getConvolverImpulse(nodeId);

      // For now, we'll skip this as the method might not exist yet
      // You can implement getConvolverImpulse in the Instrument class
      console.log(
        `Convolver impulse extraction not yet implemented for node ${nodeId}`,
      );

      // When implemented:
      // if (impulseData && impulseData.length > 0) {
      //   const asset = encodeFloat32ArrayToBase64(
      //     impulseData,
      //     48000, // Common IR sample rate
      //     2,     // Stereo IRs are common
      //     AssetType.ImpulseResponse,
      //     nodeId,
      //   );
      //   assets.set(asset.id, asset);
      // }
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
  samplerNodeIds: number[],
  convolverNodeIds: number[],
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
export function getSamplerNodeIds(synthLayout: SynthLayout): number[] {
  const nodeIds: number[] = [];

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
export function getConvolverNodeIds(synthLayout: SynthLayout): number[] {
  const nodeIds: number[] = [];

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

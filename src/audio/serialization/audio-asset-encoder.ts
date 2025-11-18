// src/audio/serialization/audio-asset-encoder.ts
import type { AudioAsset, AudioAssetType } from '../types/preset-types';

/**
 * Encodes an AudioBuffer to a base64-encoded WAV string
 */
export async function encodeAudioBufferToBase64(
  audioBuffer: AudioBuffer,
  assetType: AudioAssetType,
  nodeId: number,
  fileName?: string,
  rootNote?: number,
): Promise<AudioAsset> {
  // Convert AudioBuffer to WAV format
  const wavData = audioBufferToWav(audioBuffer);

  // Convert to base64
  const base64Data = arrayBufferToBase64(wavData);

  const asset: AudioAsset = {
    id: `${assetType}_${nodeId}`,
    type: assetType,
    base64Data,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    duration: audioBuffer.duration,
  };

  if (rootNote !== undefined) {
    asset.rootNote = rootNote;
  }
  if (fileName !== undefined) {
    asset.fileName = fileName;
  }

  return asset;
}

/**
 * Encodes raw Float32Array audio data to base64-encoded WAV
 */
export function encodeFloat32ArrayToBase64(
  samples: Float32Array,
  sampleRate: number,
  channels: number,
  assetType: AudioAssetType,
  nodeId: number,
  fileName?: string,
  rootNote?: number,
): AudioAsset {
  // Convert Float32Array to WAV
  const wavData = float32ArrayToWav(samples, sampleRate, channels);

  // Convert to base64
  const base64Data = arrayBufferToBase64(wavData);

  const duration = samples.length / channels / sampleRate;

  const asset: AudioAsset = {
    id: `${assetType}_${nodeId}`,
    type: assetType,
    base64Data,
    sampleRate,
    channels,
    duration,
  };

  if (rootNote !== undefined) {
    asset.rootNote = rootNote;
  }
  if (fileName !== undefined) {
    asset.fileName = fileName;
  }

  return asset;
}

/**
 * Decodes a base64-encoded audio asset to an AudioBuffer
 */
export async function decodeAudioAssetToBuffer(
  asset: AudioAsset,
  audioContext: AudioContext,
): Promise<AudioBuffer> {
  // Convert base64 to ArrayBuffer
  const arrayBuffer = base64ToArrayBuffer(asset.base64Data);

  // Decode the WAV data
  return await audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Decodes a base64-encoded audio asset to Float32Array
 * Returns interleaved audio data
 */
export function decodeAudioAssetToFloat32Array(asset: AudioAsset): Float32Array {
  // Convert base64 to ArrayBuffer
  const arrayBuffer = base64ToArrayBuffer(asset.base64Data);

  // Parse WAV file
  return wavToFloat32Array(arrayBuffer);
}

/**
 * Converts an AudioBuffer to WAV format (ArrayBuffer)
 */
function audioBufferToWav(audioBuffer: AudioBuffer): ArrayBuffer {
  const numberOfChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;

  // Get channel data
  const channels: Float32Array[] = [];
  for (let i = 0; i < numberOfChannels; i++) {
    channels.push(audioBuffer.getChannelData(i));
  }

  // Interleave channels
  const interleaved = new Float32Array(length * numberOfChannels);
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numberOfChannels; ch++) {
      const channelData = channels[ch];
      if (channelData) {
        interleaved[i * numberOfChannels + ch] = channelData[i] ?? 0;
      }
    }
  }

  return float32ArrayToWav(interleaved, sampleRate, numberOfChannels);
}

/**
 * Converts interleaved Float32Array to WAV format
 */
function float32ArrayToWav(
  samples: Float32Array,
  sampleRate: number,
  numChannels: number,
): ArrayBuffer {
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;

  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM samples
  const offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(offset + i * 2, int16, true);
  }

  return buffer;
}

/**
 * Parses a WAV file to Float32Array
 */
function wavToFloat32Array(arrayBuffer: ArrayBuffer): Float32Array {
  const view = new DataView(arrayBuffer);

  // Parse WAV header
  const riff = readString(view, 0, 4);
  if (riff !== 'RIFF') {
    throw new Error('Invalid WAV file: missing RIFF header');
  }

  const wave = readString(view, 8, 4);
  if (wave !== 'WAVE') {
    throw new Error('Invalid WAV file: missing WAVE header');
  }

  // Find data chunk
  let offset = 12;
  let dataOffset = 0;
  let dataSize = 0;
  let bitsPerSample = 0;

  while (offset < view.byteLength) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    offset += 8 + chunkSize;
  }

  if (!dataOffset) {
    throw new Error('Invalid WAV file: data chunk not found');
  }

  // Read samples
  const numSamples = dataSize / (bitsPerSample / 8);
  const samples = new Float32Array(numSamples);

  if (bitsPerSample === 16) {
    for (let i = 0; i < numSamples; i++) {
      const int16 = view.getInt16(dataOffset + i * 2, true);
      samples[i] = int16 / (int16 < 0 ? 0x8000 : 0x7fff);
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < numSamples; i++) {
      const uint8 = view.getUint8(dataOffset + i);
      samples[i] = (uint8 - 128) / 128;
    }
  } else {
    throw new Error(`Unsupported bits per sample: ${bitsPerSample}`);
  }

  return samples;
}

/**
 * Converts ArrayBuffer to base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

/**
 * Converts base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Writes a string to a DataView
 */
function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

/**
 * Reads a string from a DataView
 */
function readString(view: DataView, offset: number, length: number): string {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += String.fromCharCode(view.getUint8(offset + i));
  }
  return str;
}

import { defineStore } from 'pinia';
import type { AudioAsset } from 'src/audio/types/preset-types';
import { parseAudioAssetId } from 'src/audio/serialization/patch-serializer';
import type InstrumentV2 from 'src/audio/instrument-v2';

export const useAssetStore = defineStore('assetStore', {
  state: () => ({
    audioAssets: new Map<string, AudioAsset>(),
  }),
  actions: {
    setAudioAssets(assets: Map<string, AudioAsset>) {
      this.audioAssets = assets;
    },
    mergeAudioAssets(assets: Map<string, AudioAsset>) {
      this.audioAssets = new Map([...this.audioAssets, ...assets]);
    },
    clearAudioAssets() {
      this.audioAssets = new Map();
    },
    async restoreAudioAssets(instrument: InstrumentV2 | null): Promise<void> {
      if (!instrument || this.audioAssets.size === 0) {
        return;
      }

      for (const [assetId, asset] of this.audioAssets.entries()) {
        try {
          const parsed = parseAudioAssetId(assetId);
          if (!parsed) continue;
          const { nodeType, nodeId } = parsed;

          const binaryData = atob(asset.base64Data);
          const bytes = new Uint8Array(binaryData.length);
          for (let i = 0; i < binaryData.length; i++) {
            bytes[i] = binaryData.charCodeAt(i);
          }

          if (nodeType === 'sample') {
            await instrument.importSampleData(nodeId, bytes);
          } else if (nodeType === 'impulse_response') {
            await instrument.importImpulseWaveformData(nodeId, bytes);
          } else if (nodeType === 'wavetable') {
            await instrument.importWavetableData(nodeId, bytes);
          }
        } catch (error) {
          console.error(`Failed to restore audio asset ${assetId}:`, error);
        }
      }
    },
  },
});

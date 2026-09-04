// src/audio/mod-instrument.ts
/**
 * This app's tracker instrument: the library's sampler, fed from a `Patch`.
 *
 * All the audio is `TrackerSamplerInstrument` in
 * `@another-synth/tracker-playback` -- voices, envelopes, loops, conditioning,
 * the lot. What is left here is the same boundary the importers stop at: the
 * library says what a sample *is*, and this app stores its instruments as
 * sampler patches, so something has to decode one into the other. That
 * something is small, and it is this.
 *
 * `song-bank.ts` calls `loadPatch` polymorphically across `InstrumentV2 |
 * ModInstrument | PooledInstrument`, which is why the patch entry point lives
 * on a subclass rather than being pushed into the library.
 */
import type { Patch } from './types/preset-types';
import { AudioAssetType } from './types/preset-types';
import { SamplerLoopMode, type SamplerState } from './types/synth-layout';
import { decodeAudioAssetToFloat32Array } from './serialization/audio-asset-encoder';
import {
  TrackerSamplerInstrument,
  type TrackerSamplerConfig,
  type TrackerSampleLoop,
} from '@another-synth/tracker-playback';

/** The app's serialised loop enum, as the library's loop vocabulary. */
function toTrackerLoop(mode: SamplerLoopMode): TrackerSampleLoop {
  switch (mode) {
    case SamplerLoopMode.PingPong:
      return 'pingpong';
    case SamplerLoopMode.Loop:
      return 'forward';
    default:
      return 'off';
  }
}

/**
 * The playable subset of a `SamplerState`.
 *
 * A `SamplerState` carries the whole synth sampler node; the instrument reads
 * eleven of its fields. Loop points are already normalised 0..1 on both sides,
 * so they pass through unchanged.
 */
function toSamplerConfig(state: SamplerState): TrackerSamplerConfig {
  return {
    id: state.id,
    rootNote: state.rootNote,
    detune: state.detune,
    gain: state.gain,
    ...(state.pan !== undefined ? { pan: state.pan } : {}),
    loopMode: toTrackerLoop(state.loopMode),
    loopStart: state.loopStart,
    loopEnd: state.loopEnd,
    ...(state.trackerEnvelope ? { trackerEnvelope: state.trackerEnvelope } : {}),
    ...(state.trackerPanEnvelope
      ? { trackerPanEnvelope: state.trackerPanEnvelope }
      : {}),
    ...(state.trackerAutoVibrato
      ? { trackerAutoVibrato: state.trackerAutoVibrato }
      : {}),
  };
}

export default class ModInstrument extends TrackerSamplerInstrument {
  /**
   * Load this app's sampler patch.
   *
   * The asset lookup is deliberately forgiving: the sample asset *should* be
   * keyed by the sampler node's id, but patch normalisation can rename nodes,
   * so a patch whose ids no longer line up falls back to its first sample
   * asset rather than failing to play.
   */
  async loadPatch(patch: Patch): Promise<void> {
    const samplerStates = Object.values(patch.synthState.samplers);
    if (samplerStates.length === 0) {
      throw new Error('MOD patch must have a sampler node');
    }
    const samplerState = samplerStates[0]!;

    let assetId = samplerState.id;
    let asset = patch.audioAssets[assetId];

    if (!asset || asset.type !== AudioAssetType.Sample) {
      const sampleAssets = Object.entries(patch.audioAssets).filter(
        ([, a]) => a.type === AudioAssetType.Sample,
      );
      if (sampleAssets.length > 0) {
        [assetId, asset] = sampleAssets[0]!;
      } else {
        throw new Error(
          `No sample assets found in patch. Available assets: ${Object.keys(patch.audioAssets).join(', ')}`,
        );
      }
    }

    if (asset.type !== AudioAssetType.Sample) {
      throw new Error(`Asset ${assetId} is not a sample (type: ${asset.type})`);
    }

    await this.load(
      toSamplerConfig(samplerState),
      decodeAudioAssetToFloat32Array(asset),
      asset.sampleRate,
      asset.channels,
      patch.synthState.layout?.voiceCount,
    );
  }
}

/**
 * A ProTracker sample as the editor and the .mod exporter see it, and the
 * conversions between that and the app's sampler patch.
 *
 * The song keeps a slot's audio as a sampler `Patch` (that is what plays it);
 * a .mod holds 8-bit mono data with a header. `modSampleOfSlot` reads the
 * first from the second's point of view and `patchFromModSample` goes back,
 * so the editor and the exporter agree on what a slot holds.
 */
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { decodeAudioAssetToFloat32Array } from 'src/audio/serialization/audio-asset-encoder';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import type { Patch } from 'src/audio/types/preset-types';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  PAULA_TO_SYNTH_SCALE,
  formatInstrumentId,
  trackerSampleFromModSample,
  type ModSample,
} from '@another-synth/tracker-playback';

/** The most a .mod sample can hold: 65535 words. */
export const MOD_MAX_SAMPLE_BYTES = 0x1fffe;
export const MOD_NAME_LENGTH = 22;

export function emptyModSample(volume = 64): ModSample {
  return { name: '', length: 0, finetune: 0, volume, loopStart: 0, loopLength: 0, data: new Int8Array(0) };
}

/** The app's own placeholder for an unnamed sample is not a name. */
export function isPlaceholderName(slot: Pick<InstrumentSlot, 'slot' | 'instrumentName'>): boolean {
  return !slot.instrumentName || slot.instrumentName === `Instrument ${formatInstrumentId(slot.slot)}`;
}

/**
 * The slot's sample as a .mod would hold it. `notes` collects what had to be
 * approximated (a sample that was never a module sample, a loop a .mod can't
 * express). A slot with no sampler gives an empty sample.
 */
export function modSampleOfSlot(
  slot: InstrumentSlot,
  patch: Patch | undefined,
  notes: Set<string> = new Set(),
): ModSample {
  const empty = emptyModSample(Math.max(0, Math.min(64, slot.modVolume ?? 64)));
  empty.name = isPlaceholderName(slot) ? '' : slot.instrumentName;
  if (!patch) return empty;
  const sampler = Object.values(patch.synthState.samplers ?? {})[0];
  const asset = sampler ? Object.values(patch.audioAssets ?? {})[0] : undefined;
  if (!sampler || !asset) {
    notes.add(`Instrument ${slot.slot} is not a sample and is written empty.`);
    return empty;
  }

  let pcm = decodeAudioAssetToFloat32Array(asset);
  const channels = Math.max(1, asset.channels || 1);
  if (channels > 1) {
    const mono = new Float32Array(Math.floor(pcm.length / channels));
    for (let i = 0; i < mono.length; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += pcm[i * channels + c] ?? 0;
      mono[i] = sum / channels;
    }
    pcm = mono;
  }

  // The app plays a sample at (rate / 128) / f(root) times Paula's speed; a
  // module sample has to play at exactly Paula's, so resample by that factor.
  const rate = sampler.sampleRate || asset.sampleRate || 44100;
  const rootHz = 440 * Math.pow(2, (sampler.rootNote - 69) / 12);
  const factor = rate / PAULA_TO_SYNTH_SCALE / rootHz;
  const scale = Math.abs(factor - 1) < 1e-4 ? 1 : 1 / factor;
  let outLength = Math.max(0, Math.round(pcm.length * scale));
  if (outLength > MOD_MAX_SAMPLE_BYTES) {
    outLength = MOD_MAX_SAMPLE_BYTES;
    notes.add(`Instrument ${slot.slot} is longer than a .mod sample can be (128 KB) and was cut.`);
  }
  const data = new Int8Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let value: number;
    if (scale === 1) {
      value = pcm[i] ?? 0;
    } else {
      const at = i / scale;
      const i0 = Math.floor(at);
      const frac = at - i0;
      value = (pcm[i0] ?? 0) * (1 - frac) + (pcm[i0 + 1] ?? pcm[i0] ?? 0) * frac;
    }
    data[i] = Math.max(-128, Math.min(127, Math.round(value * 128)));
  }

  let loopStart = 0;
  let loopLength = 0;
  if (sampler.loopMode !== SamplerLoopMode.Off && outLength > 0) {
    if (sampler.loopMode === SamplerLoopMode.PingPong) {
      notes.add(`Instrument ${slot.slot} loops ping-pong; a .mod can only loop forward.`);
    }
    loopStart = Math.max(0, Math.min(outLength - 2, Math.round(sampler.loopStart * outLength) & ~1));
    const loopEnd = Math.max(0, Math.min(outLength, Math.round(sampler.loopEnd * outLength) & ~1));
    loopLength = loopEnd - loopStart;
    if (loopLength <= 2) {
      loopStart = 0;
      loopLength = 0;
    }
  }

  const cents = sampler.detune_cents ?? sampler.detune ?? 0;
  const finetune = Math.max(-8, Math.min(7, Math.round((cents / 100) * 8)));
  if (Math.abs(cents - (finetune / 8) * 100) > 6.25) {
    notes.add(`Instrument ${slot.slot}'s tuning is outside a .mod's finetune range and was clamped.`);
  }

  return { ...empty, length: outLength, finetune, loopStart, loopLength, data };
}

/**
 * The sampler patch that plays `sample` in slot `slotNumber`. With `existing`
 * the patch keeps its identity (id, created, category) and bumps its revision,
 * so the song bank treats it as an edit rather than a different instrument.
 */
export function patchFromModSample(slotNumber: number, sample: ModSample, existing?: Patch, voiceCount = 4): Patch {
  const fresh = createSamplerPatch(trackerSampleFromModSample(sample, slotNumber, voiceCount), {
    fallbackName: `Instrument ${formatInstrumentId(slotNumber)}`,
    category: 'Imported/MOD',
  });
  if (existing) {
    fresh.metadata.id = existing.metadata.id;
    fresh.metadata.created = existing.metadata.created;
    fresh.metadata.revision = (existing.metadata.revision ?? 0) + 1;
    if (existing.metadata.category !== undefined) fresh.metadata.category = existing.metadata.category;
  }
  return fresh;
}

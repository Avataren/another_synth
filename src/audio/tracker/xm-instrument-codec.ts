/**
 * An XM instrument as the editor and the .xm exporter see it, and the
 * conversions between that and the app's sampler patch.
 *
 * The song keeps a slot's audio as a sampler `Patch` (zone 0 is the sampler
 * node, the rest are `trackerZones`) and the header fields the patch has no
 * place for as `slot.xmInstrument`. `xmInstrumentOfSlot` joins the two and
 * `patchFromXmInstrument` goes back.
 */
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { decodeAudioAssetToFloat32Array } from 'src/audio/serialization/audio-asset-encoder';
import { SamplerLoopMode } from 'src/audio/types/synth-layout';
import type { Patch } from 'src/audio/types/preset-types';
import { createSamplerPatch } from 'src/audio/tracker/sampler-patch-builder';
import {
  emptyXmInstrumentMeta,
  emptyXmSampleMeta,
  formatInstrumentId,
  trackerSampleFromXm,
  xmInstrumentOf,
  XM_ROOT_NOTE,
  type XmInstrument,
  type XmInstrumentMeta,
  type XmLoopType,
  type XmSamplePcm,
} from '@another-synth/tracker-playback';

export const XM_NAME_LENGTH = 22;

/** The app's own placeholder for an unnamed instrument is not a name. */
export function isPlaceholderXmName(slot: Pick<InstrumentSlot, 'slot' | 'instrumentName'>): boolean {
  return !slot.instrumentName || slot.instrumentName === `Instrument ${formatInstrumentId(slot.slot)}`;
}

function loopTypeOf(mode: SamplerLoopMode): XmLoopType {
  return mode === SamplerLoopMode.PingPong ? 'pingpong' : mode === SamplerLoopMode.Loop ? 'forward' : 'none';
}

function monoOf(pcm: Float32Array, channels: number): Float32Array {
  if (channels <= 1) return pcm;
  const mono = new Float32Array(Math.floor(pcm.length / channels));
  for (let i = 0; i < mono.length; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c] ?? 0;
    mono[i] = sum / channels;
  }
  return mono;
}

interface PatchZone extends XmSamplePcm {
  rootNote: number;
  detune: number;
  pan: number | undefined;
}

function zonesOfPatch(patch: Patch): PatchZone[] {
  const sampler = Object.values(patch.synthState.samplers ?? {})[0];
  if (!sampler) return [];
  const assets = patch.audioAssets ?? {};
  const primary = assets[sampler.id] ?? Object.values(assets)[0];
  if (!primary) return [];
  const out: PatchZone[] = [];
  const push = (
    asset: typeof primary,
    z: { loopMode: SamplerLoopMode; loopStart: number; loopEnd: number; rootNote: number; detune: number; pan?: number | undefined },
  ) => {
    const data = monoOf(decodeAudioAssetToFloat32Array(asset), Math.max(1, asset.channels || 1));
    const looping = z.loopMode !== SamplerLoopMode.Off && data.length > 0;
    const start = looping ? Math.round(z.loopStart * data.length) : 0;
    const end = looping ? Math.round(z.loopEnd * data.length) : 0;
    out.push({
      data,
      loopStart: start,
      loopLength: looping ? Math.max(0, end - start) : 0,
      loopType: looping ? loopTypeOf(z.loopMode) : 'none',
      rootNote: z.rootNote,
      detune: z.detune,
      pan: z.pan,
    });
  };
  push(primary, {
    loopMode: sampler.loopMode,
    loopStart: sampler.loopStart,
    loopEnd: sampler.loopEnd,
    rootNote: sampler.rootNote,
    detune: sampler.detune_cents ?? sampler.detune ?? 0,
    pan: sampler.pan,
  });
  for (const zone of sampler.trackerZones ?? []) {
    const asset = assets[zone.assetId];
    if (asset) push(asset, zone);
  }
  return out;
}

/** Header fields reconstructed from a patch that has no stored meta. */
function metaFromPatch(slot: InstrumentSlot, patch: Patch, zones: PatchZone[]): XmInstrumentMeta {
  const sampler = Object.values(patch.synthState.samplers ?? {})[0];
  const meta = emptyXmInstrumentMeta(isPlaceholderXmName(slot) ? '' : slot.instrumentName);
  meta.samples = zones.map((z) => ({
    ...emptyXmSampleMeta(),
    finetune: Math.max(-128, Math.min(127, Math.round((z.detune / 100) * 128))),
    relativeNote: Math.max(-96, Math.min(95, Math.round(XM_ROOT_NOTE - z.rootNote))),
    panning: z.pan === undefined ? 128 : Math.max(0, Math.min(255, Math.round(z.pan * 255))),
  }));
  const map = sampler?.trackerZoneMap;
  if (map) meta.keymap = map.slice(0, 96).map((n) => Math.max(0, Math.min(zones.length - 1, n)));
  const env = sampler?.trackerEnvelope;
  if (env) {
    meta.volumeEnvelope = {
      points: env.points.map((p) => ({ frame: p.tick, value: p.value })),
      sustainPoint: Math.max(0, env.sustainPoint),
      loopStart: env.loopStart,
      loopEnd: env.loopEnd,
      enabled: true,
      sustainEnabled: env.sustainPoint >= 0,
      loopEnabled: env.loopEnabled,
    };
    meta.volumeFadeout = env.fadeout;
  }
  const pan = sampler?.trackerPanEnvelope;
  if (pan) {
    meta.panningEnvelope = {
      points: pan.points.map((p) => ({ frame: p.tick, value: p.value })),
      sustainPoint: Math.max(0, pan.sustainPoint),
      loopStart: pan.loopStart,
      loopEnd: pan.loopEnd,
      enabled: true,
      sustainEnabled: pan.sustainPoint >= 0,
      loopEnabled: pan.loopEnabled,
    };
  }
  const vib = sampler?.trackerAutoVibrato;
  if (vib) {
    meta.vibratoType = vib.type;
    meta.vibratoSweep = vib.sweepTicks;
    meta.vibratoDepth = vib.depth;
    meta.vibratoRate = vib.rate;
  }
  return meta;
}

/**
 * The slot's instrument as a .xm would hold it, or undefined when the slot has
 * no sampler. `notes` collects what had to be approximated.
 */
export function xmInstrumentOfSlot(
  slot: InstrumentSlot,
  patch: Patch | undefined,
): XmInstrument | undefined {
  const named = isPlaceholderXmName(slot) ? '' : slot.instrumentName;
  if (!patch) {
    if (!slot.xmInstrument) return undefined;
    // Header with no audio: every sample is empty.
    return xmInstrumentOf(
      { ...slot.xmInstrument },
      slot.xmInstrument.samples.map(() => ({ data: new Float32Array(0), loopStart: 0, loopLength: 0, loopType: 'none' })),
    );
  }
  const zones = zonesOfPatch(patch);
  if (zones.length === 0) return undefined;
  const stored = slot.xmInstrument;
  const meta =
    stored && stored.samples.length === zones.length
      ? { ...stored }
      : metaFromPatch(slot, patch, zones);
  meta.name = stored ? stored.name : named;
  return xmInstrumentOf(meta, zones);
}

/**
 * The sampler patch that plays `instrument` in slot `slotNumber`. With
 * `existing` the patch keeps its identity (id, created, category) and bumps
 * its revision, so the song bank treats it as an edit.
 */
export function patchFromXmInstrument(
  slotNumber: number,
  instrument: XmInstrument,
  existing?: Patch,
  voiceCount = 8,
): Patch | null {
  if (instrument.samples.length === 0) return null;
  const fresh = createSamplerPatch(trackerSampleFromXm(instrument, slotNumber, slotNumber, voiceCount), {
    fallbackName: `Instrument ${formatInstrumentId(slotNumber)}`,
    category: 'Imported/XM',
  });
  if (existing) {
    fresh.metadata.id = existing.metadata.id;
    fresh.metadata.created = existing.metadata.created;
    fresh.metadata.revision = (existing.metadata.revision ?? 0) + 1;
    if (existing.metadata.category !== undefined) fresh.metadata.category = existing.metadata.category;
  }
  return fresh;
}

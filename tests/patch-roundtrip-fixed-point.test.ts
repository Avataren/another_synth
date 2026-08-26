import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  serializeCurrentPatch,
  deserializePatch,
} from '../src/audio/serialization/patch-serializer';
import type { Patch } from '../src/audio/types/preset-types';

/**
 * This test simulates exactly what happens when a user opens the instrument
 * editor for a tracker slot and returns to the tracker WITHOUT making any
 * intentional edits:
 *
 *   1. patchStore.applyPatchObject(patch) -> nodeStateStore.assignStatesFromPatch(deserializePatch(patch))
 *   2. patchStore.serializePatch() -> serializeCurrentPatch({ ...values read back out of nodeStateStore })
 *
 * i.e. deserialize(patch) -> reserialize -> patch'
 *
 * Because the song bank rebuilds the live tracker instrument from the newly
 * saved patch whenever its content hash changes (see
 * TrackerSongBank.ensureInstrumentInternal / computePatchSignature), patch'
 * must be *identical* (a fixed point) to patch for the instrument to sound
 * the same after a round trip through the editor. If a second round trip
 * (patch' -> patch'') produces something different again, or if patch' ever
 * differs meaningfully from patch, the tracker's rebuilt instrument will
 * drift from what the editor was actually playing.
 */

function roundTrip(patch: Patch): Patch {
  const deserialized = deserializePatch(patch);
  return serializeCurrentPatch({
    name: patch.metadata.name,
    layout: deserialized.layout,
    oscillators: deserialized.oscillators,
    wavetableOscillators: deserialized.wavetableOscillators,
    filters: deserialized.filters,
    envelopes: deserialized.envelopes,
    lfos: deserialized.lfos,
    samplers: deserialized.samplers,
    glides: deserialized.glides,
    convolvers: deserialized.convolvers,
    delays: deserialized.delays,
    choruses: deserialized.choruses,
    reverbs: deserialized.reverbs,
    compressors: deserialized.compressors,
    saturations: deserialized.saturations,
    bitcrushers: deserialized.bitcrushers,
    noise: deserialized.noise,
    velocity: deserialized.velocity,
    audioAssets: deserialized.audioAssets,
    metadata: patch.metadata,
    macros: deserialized.macros,
    instrumentGain: patch.synthState.instrumentGain,
  });
}

function loadSystemBankPatches(): Patch[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bankPath = path.resolve(here, '../public/system-bank.json');
  const raw = JSON.parse(readFileSync(bankPath, 'utf-8')) as {
    patches: Patch[];
  };
  return raw.patches;
}

describe('instrument editor round trip preserves patch state', () => {
  const patches = loadSystemBankPatches();

  it('loaded at least one patch from the system bank fixture', () => {
    expect(patches.length).toBeGreaterThan(0);
  });

  it.each(patches.map((p) => [p.metadata.name, p] as const))(
    'is a fixed point under deserialize/serialize for "%s"',
    (_name, patch) => {
      const round1 = roundTrip(patch);
      const round2 = roundTrip(round1);

      // round1 -> round2 must be a no-op: opening the editor a second time
      // and leaving again must not change anything further.
      expect(round2.synthState).toEqual(round1.synthState);
    },
  );

  it.each(patches.map((p) => [p.metadata.name, p] as const))(
    'matches the original synthState for "%s" (edit-then-return is lossless)',
    (_name, patch) => {
      const round1 = roundTrip(patch);
      // toMatchObject rather than toEqual: older fixture patches predate
      // newer optional sections (e.g. `saturations`) and normalizing them
      // in is an intentional, additive, one-time schema upgrade -- not data
      // loss. Every field that *was* present in the original must still be
      // present with the same value.
      expect(round1.synthState).toMatchObject(patch.synthState);
    },
  );
});

import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  useTrackerStore,
  type InstrumentSlot,
  type TrackerSongFile,
} from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { createDefaultPatchMetadata, createEmptySynthState } from 'src/audio/types/preset-types';
import type { Patch } from 'src/audio/types/preset-types';

const demo = (name: string): ArrayBuffer => {
  const b = fs.readFileSync(path.resolve(__dirname, '../../../public/demos/ahx', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function loadedKarma() {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(demo('karma.ahx')));
  return store;
}

function patchNamed(id: string): Patch {
  const metadata = createDefaultPatchMetadata(id);
  metadata.id = id;
  return { metadata, synthState: createEmptySynthState(), audioAssets: {} };
}

describe('tracker store: editing an AHX instrument', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('writes an edited instrument through to the slot, keeping the file’s name', () => {
    const store = loadedKarma();
    const originalName = store.instrumentSlots[0]!.ahxData!.name;
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.volume = 12;
    edited.envelope.dVolume = 5;
    edited.name = 'renamed';
    expect(store.updateAhxInstrument(1, edited)).toBe(true);
    expect(store.instrumentSlots[0]!.ahxData).toMatchObject({
      volume: 12,
      envelope: { dVolume: 5 },
      name: originalName,
    });
  });

  it('refuses a value that is not a valid instrument, and a slot that is not an AHX one', () => {
    const store = loadedKarma();
    const before = clone(store.instrumentSlots[0]!.ahxData);
    const bad = clone(before!);
    bad.waveLength = 9;
    expect(store.updateAhxInstrument(1, bad)).toBe(false);
    expect(store.updateAhxInstrument(1, { ...clone(before!), plist: null } as unknown as AhxInstrument)).toBe(false);
    expect(store.updateAhxInstrument(60, clone(before!))).toBe(false); // an empty slot
    expect(store.updateAhxInstrument(999, clone(before!))).toBe(false); // no such slot
    expect(store.instrumentSlots[0]!.ahxData).toEqual(before);
  });

  it('keeps edits through a serialize / load round trip', () => {
    const store = loadedKarma();
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.envelope.aFrames = 9;
    edited.plist.entries.push({ note: 30, waveform: 3, fixed: true, fx: [4, 12], fxParam: [0, 0x40] });
    expect(store.updateAhxInstrument(1, edited)).toBe(true);

    const saved = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    setActivePinia(createPinia());
    const reloaded = useTrackerStore();
    reloaded.loadSongFile(saved);
    expect(reloaded.instrumentSlots[0]!.ahxData).toEqual(store.instrumentSlots[0]!.ahxData);
    expect(reloaded.instrumentSlots[0]!.ahxData!.plist.entries.at(-1)).toEqual(edited.plist.entries.at(-1));
  });
});

describe('tracker store: crafted ahxData on load', () => {
  beforeEach(() => setActivePinia(createPinia()));

  const withAhxData = (ahxData: unknown): TrackerSongFile => {
    const file = importAhxToTrackerSong(demo('karma.ahx'));
    const saved = clone(file);
    (saved.data.instrumentSlots[0] as InstrumentSlot).ahxData = ahxData as AhxInstrument;
    return saved;
  };

  it.each([
    ['null-ish plist', { ...parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1], plist: null }],
    ['a string', 'not an instrument'],
    ['a number', 42],
    ['an array', []],
    ['an envelope of the wrong type', { ...parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1], envelope: 7 }],
    ['out of range values', { ...parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1], waveLength: 200, volume: -3 }],
    ['a plist of 10 000 rows', {
      ...parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1],
      plist: { speed: 1, entries: Array.from({ length: 10_000 }, () => ({ note: 1, waveform: 1, fixed: false, fx: [0, 0], fxParam: [0, 0] })) },
    }],
    ['NaN fields', { ...parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1], volume: Number.NaN }],
  ])('drops %s instead of keeping it, and the song still loads', (_label, crafted) => {
    const store = useTrackerStore();
    expect(() => store.loadSongFile(withAhxData(crafted))).not.toThrow();
    // The slot keeps its tags and name but has nothing to display or edit.
    expect(store.instrumentSlots[0]!.ahxData).toBeUndefined();
    expect(store.instrumentSlots[0]!.instrumentType).toBe('ahx');
    // The other slots are untouched.
    expect(store.instrumentSlots[1]!.ahxData).toBeDefined();
  });

  it('keeps a valid instrument as a copy, not the file’s own object', () => {
    const file = withAhxData(parseAhx(new Uint8Array(demo('karma.ahx'))).instruments[1]);
    const store = useTrackerStore();
    store.loadSongFile(file);
    const kept = store.instrumentSlots[0]!.ahxData;
    expect(kept).toEqual(file.data.instrumentSlots[0]!.ahxData);
    expect(kept).not.toBe(file.data.instrumentSlots[0]!.ahxData);
  });
});

describe('tracker store: updateEditingPatch guard', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('does nothing in a read-only (AHX) song, and never gives an AHX slot a patch', () => {
    const store = loadedKarma();
    expect(store.isReadOnly).toBe(true);
    store.startEditingSlot(1);
    store.updateEditingPatch(patchNamed('p1'));
    expect(store.instrumentSlots[0]!.patchId).toBeUndefined();
    expect(store.songPatches['p1']).toBeUndefined();
  });

  it('refuses an AHX slot even in a song that is not read-only', () => {
    const store = useTrackerStore();
    store.loadSongFile(importAhxToTrackerSong(demo('karma.ahx')));
    store.moduleFormat = 'native';
    expect(store.isReadOnly).toBe(false);
    store.startEditingSlot(1);
    store.updateEditingPatch(patchNamed('p2'));
    expect(store.instrumentSlots[0]!.patchId).toBeUndefined();
    expect(store.songPatches['p2']).toBeUndefined();
  });

  it('still updates the patch of an ordinary slot', () => {
    const store = useTrackerStore();
    store.startEditingSlot(3);
    store.updateEditingPatch(patchNamed('p3'));
    expect(store.instrumentSlots.find((s) => s.slot === 3)!.patchId).toBe('p3');
    expect(store.songPatches['p3']).toBeDefined();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { parseAhx, type AhxInstrument } from '@another-synth/tracker-playback';
import {
  useTrackerStore,
  type InstrumentSlot,
  type TrackerSongFile,
} from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  ahxSourceInfo,
  ahxSourceRecordOf,
  attachAhxSource,
  currentAhxInstrumentEdits,
  setCurrentAhxSource,
} from 'src/audio/tracker/ahx-source';
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
    // No AHX song's bytes are current here (only the display model was loaded):
    // the edit is kept in the slot and cannot be heard, and the caller is told.
    expect(store.updateAhxInstrument(1, edited)).toBe('kept');
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
    expect(store.updateAhxInstrument(1, bad)).toBe('rejected');
    expect(store.updateAhxInstrument(1, { ...clone(before!), plist: null } as unknown as AhxInstrument)).toBe('rejected');
    expect(store.updateAhxInstrument(60, clone(before!))).toBe('rejected'); // an empty slot
    expect(store.updateAhxInstrument(999, clone(before!))).toBe('rejected'); // no such slot
    expect(store.instrumentSlots[0]!.ahxData).toEqual(before);
  });

  it('keeps edits through a serialize / load round trip', () => {
    const store = loadedKarma();
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.envelope.aFrames = 9;
    edited.plist.entries.push({ note: 30, waveform: 3, fixed: true, fx: [4, 12], fxParam: [0, 0x40] });
    expect(store.updateAhxInstrument(1, edited)).toBe('kept');

    const saved = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    setActivePinia(createPinia());
    const reloaded = useTrackerStore();
    reloaded.loadSongFile(saved);
    expect(reloaded.instrumentSlots[0]!.ahxData).toEqual(store.instrumentSlots[0]!.ahxData);
    expect(reloaded.instrumentSlots[0]!.ahxData!.plist.entries.at(-1)).toEqual(edited.plist.entries.at(-1));
  });
});

describe('tracker store: the format and version of the song', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
  });
  afterEach(() => setCurrentAhxSource(null));

  it('an edit of a song with bytes is applied (heard), and reaches the recorded edits in the song\'s format', () => {
    const store = loadedKarma();
    const file = importAhxToTrackerSong(demo('karma.ahx'));
    const rec = ahxSourceRecordOf(file)!;
    setCurrentAhxSource(rec.bytes, rec);
    expect(ahxSourceInfo.value).toEqual({ format: 'ahx', version: rec.version });
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.volume = 20;
    expect(store.updateAhxInstrument(1, edited)).toBe('applied');
    expect(currentAhxInstrumentEdits()).toHaveLength(1);
    expect(currentAhxInstrumentEdits()[0]!.bytes[0]).toBe(20);
  });

  it('an HVL song\'s instrument keeps the commands and the wide PList layout only HVL has', () => {
    const store = loadedKarma();
    const hvl = fs.readFileSync(path.resolve(__dirname, '../../../public/demos/ahx/sunspots.hvl'));
    const bytes = new Uint8Array(hvl.buffer.slice(hvl.byteOffset, hvl.byteOffset + hvl.byteLength));
    setCurrentAhxSource(bytes);
    expect(ahxSourceInfo.value!.format).toBe('hvl');
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.plist.entries = [{ note: 10, waveform: 3, fixed: false, fx: [9, 0], fxParam: [1, 0] }];
    // Command 9 exists in HVL's PList only: an AHX-hard-coded store would reject the edit.
    expect(store.updateAhxInstrument(1, edited)).toBe('applied');
    expect(store.instrumentSlots[0]!.ahxData!.plist.entries[0]!.fx[0]).toBe(9);
    // HVL entries are 5 bytes wide: 22 + 5.
    expect(currentAhxInstrumentEdits()[0]!.bytes.length).toBe(22 + 5);
  });

  it('a version-0 AHX song keeps no high nibble on a filter-toggle parameter, as the engine reads it', () => {
    const store = loadedKarma();
    setCurrentAhxSource(new Uint8Array([0x54, 0x48, 0x58, 0]));
    expect(ahxSourceInfo.value).toEqual({ format: 'ahx', version: 0 });
    const edited = clone(store.instrumentSlots[0]!.ahxData!);
    edited.plist.entries = [{ note: 10, waveform: 3, fixed: false, fx: [4, 5], fxParam: [0xa7, 0xb3] }];
    expect(store.updateAhxInstrument(1, edited)).toBe('applied');
    // fx 4 (filter toggle) is stripped to its low nibble; fx 5 (a jump) is not.
    expect(store.instrumentSlots[0]!.ahxData!.plist.entries[0]!.fxParam).toEqual([0x07, 0xb3]);
  });

  it('an HVL song\'s slot with HVL-only commands survives a load; the same data in an AHX song does not', () => {
    const file = importAhxToTrackerSong(demo('karma.ahx'));
    const saved = clone(file);
    const slot = saved.data.instrumentSlots[0] as InstrumentSlot;
    slot.ahxData!.plist.entries = [{ note: 1, waveform: 1, fixed: false, fx: [9, 0], fxParam: [0, 0] }];
    const asAhx = useTrackerStore();
    asAhx.loadSongFile(saved);
    expect(asAhx.instrumentSlots[0]!.ahxData).toBeUndefined();

    setActivePinia(createPinia());
    const asHvl = useTrackerStore();
    attachAhxSource(saved, new Uint8Array([0x48, 0x56, 0x4c, 1]), { format: 'hvl', version: 1 });
    asHvl.loadSongFile(saved);
    expect(asHvl.instrumentSlots[0]!.ahxData!.plist.entries[0]!.fx[0]).toBe(9);
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

  it('does nothing in an AHX song, and never gives an AHX slot a patch', () => {
    const store = loadedKarma();
    // The import carries its bytes, so the song has a doc and is editable; its
    // instrument slots are still not the patch editor's.
    expect(store.isAhxSong).toBe(true);
    expect(store.isReadOnly).toBe(false);
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

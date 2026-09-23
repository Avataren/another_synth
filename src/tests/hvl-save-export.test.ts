import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx } from '@another-synth/tracker-playback';
import { useTrackerStore, type TrackerSongFile } from 'src/stores/tracker-store';
import { useTrackerFileIO, type TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import { attachAhxSource, currentAhxSource, setCurrentAhxSource, snapshotEditorSong } from 'src/audio/tracker/ahx-source';
import { buildAhxFile, decodeAhxFile, encodeAhxFile } from 'src/audio/tracker/ahx-doc';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { ahxExporter, describeSongExporter, hvlExporter, serializeAhx } from 'src/audio/tracker/song-export';
import { fittingHvlModel } from './helpers/fitting-hvl';

/**
 * plan-hvl-editing.md P3: an HVL song with a doc saves and exports what the
 * editor holds. The `.cmod` carries the file (`data.ahxFile`, as an AHX song's
 * does) and loads back editable; the HVL row exports that file; an untouched
 * song is its source file byte for byte (no rebuild); the AHX row never hands
 * out HVL bytes as `.ahx`; an HVL with no name keeps no name.
 *
 * The songs go through the real store and the real `useTrackerFileIO`
 * (`applySongFile`, `handleSaveSongFile`, the `.cmod` zip and its reading).
 */
const DEMOS = path.resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(DEMOS, name)));
const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const MELTWATER = demo('meltwater_10ch.hvl');

type Store = ReturnType<typeof useTrackerStore>;

/** `useTrackerFileIO` on the real store, with the audio side faked; `saved` collects what a save writes. */
function fileIO(store: Store) {
  const saved: Blob[] = [];
  const picker = vi.fn(async () => ({
    createWritable: async () => ({ write: async (blob: Blob) => void saved.push(blob), close: async () => {} }),
  }));
  vi.stubGlobal('window', { ...window, showSaveFilePicker: picker });
  const notify = vi.fn();
  const ctx: TrackerFileIOContext = {
    trackerStore: store,
    songBank: {
      audioContext: { state: 'running', resume: async () => {} },
      resetForNewSong: vi.fn(),
      setModuleFormat: vi.fn(),
    } as unknown as TrackerSongBank,
    currentSong: ref({ title: store.currentSong.title, author: '', bpm: 125 }),
    playbackMode: ref<'pattern' | 'song'>('song'),
    isLoadingSong: ref(false),
    ensureActiveInstrument: vi.fn(),
    syncSongBankFromSlots: vi.fn().mockResolvedValue(undefined),
    initializePlayback: vi.fn().mockResolvedValue(true),
    stopPlayback: vi.fn(),
    resetSequenceIndex: vi.fn(),
    notify,
  };
  return { io: useTrackerFileIO(ctx), saved, notify, picker };
}

/** Opens a `.hvl` file the way the page does (`loadSongFromFile`). */
async function openHvl(bytes: Uint8Array): Promise<Store> {
  const store = useTrackerStore();
  const { io } = fileIO(store);
  await io.loadSongFromFile({ name: 'song.hvl', arrayBuffer: async () => toBuffer(bytes) } as unknown as File);
  expect(store.ahxDoc?.format).toBe('hvl');
  return store;
}

/** One real grid edit on channel `channel` of position 0 (row 3: a note with instrument 1). */
function editCell(store: Store, channel: number): void {
  const cell = store.patterns[0]!.tracks[channel]!;
  cell.entries = [...cell.entries.filter((e) => e.row !== 3), { row: 3, note: 'C-3', instrument: '01' }];
  store.syncAhxWriteBack();
}

const embedded = (file: TrackerSongFile): Uint8Array => {
  const decoded = decodeAhxFile(file.data.ahxFile);
  if (!decoded.ok) throw new Error(`no usable ahxFile: ${decoded.reason}`);
  return decoded.bytes;
};

/** Row 3 of the track position 0 plays on `channel`, in the file. */
const stepAt = (bytes: Uint8Array, channel: number) => {
  const song = parseAhx(bytes);
  return song.tracks[song.positions[0]!.track[channel]!]![3]!;
};

/** An HVL file whose song name is empty: sliding_away.hvl with its name cleared (no corpus file has one). */
function namelessHvl(): Uint8Array {
  const model = parseAhx(demo('sliding_away.hvl'));
  return serializeAhx({ ...model, name: '' });
}

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
  clearAhxEditNotice();
  vi.unstubAllGlobals();
});

describe('saving an HVL song with a doc (.cmod)', () => {
  it('an untouched song embeds its source file byte for byte (no rebuild, so no trailing NUL for meltwater)', async () => {
    const store = await openHvl(MELTWATER);
    const file = store.serializeSong();
    expect(file.data.ahxFile).toBeDefined();
    expect(embedded(file)).toEqual(MELTWATER);
  });

  it('an edit on channel 10 lands in the embedded file, and all 10 instruments with it', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    const bytes = embedded(store.serializeSong());
    const song = parseAhx(bytes);
    expect(song.format).toBe('hvl');
    expect(song.channels).toBe(10);
    expect(song.instrumentNr).toBe(10);
    expect(song.instruments).toEqual(parseAhx(MELTWATER).instruments);
    expect(stepAt(bytes, 9)).toMatchObject({ instrument: 1 });
    expect(stepAt(bytes, 9).note).not.toBe(0);
    // What the engine plays and what the save holds are the same bytes.
    expect(currentAhxSource()).toEqual(bytes);
  });

  it('handleSaveSongFile saves it (no refusal), and the .cmod opens again as the same editable song', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    store.currentSong.title = 'Meltdown';
    const expected = embedded(store.serializeSong());
    const { io, saved, notify } = fileIO(store);
    await io.handleSaveSongFile();
    expect(notify).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);

    const cmod = new Uint8Array(await saved[0]!.arrayBuffer());
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    const after = useTrackerStore();
    const reopen = fileIO(after);
    await reopen.io.loadSongFromFile({ name: 'song.cmod', arrayBuffer: async () => toBuffer(cmod) } as unknown as File);
    expect(after.ahxDoc?.format).toBe('hvl');
    expect(after.isAhxEditable).toBe(true);
    expect(after.currentSong.title).toBe('Meltdown');
    expect(after.instrumentSlots.filter((slot) => slot.ahxData !== undefined)).toEqual([]);
    // The engine plays the embedded file, and saving again changes nothing.
    expect(currentAhxSource()).toEqual(expected);
    expect(embedded(after.serializeSong())).toEqual(expected);
    expect(parseAhx(expected).name).toBe('Meltdown');
  });

  it('a doc-less HVL song (a .cmod without its bytes) is still refused, as an AHX one is', async () => {
    const store = await openHvl(MELTWATER);
    const bare = JSON.parse(JSON.stringify({ ...store.serializeSong(), data: { ...store.serializeSong().data, ahxFile: undefined } })) as TrackerSongFile;
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    const after = useTrackerStore();
    after.loadSongFile(bare);
    expect(after.ahxDoc).toBeNull();
    const { io, notify, picker } = fileIO(after);
    await io.handleSaveSongFile();
    expect(notify).toHaveBeenCalledOnce();
    expect(picker).not.toHaveBeenCalled();
    expect(describeSongExporter(hvlExporter, bare)).toEqual({ state: 'unavailable', reason: 'This song has no original file to export from.' });
  });

  it('a snapshot (the Jukebox) of an edited HVL song plays its edits again when it is put back', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    const snapshot = snapshotEditorSong(store);
    const expected = embedded(snapshot);
    setCurrentAhxSource(null);
    await fileIO(store).io.applySongFile(snapshot);
    expect(store.ahxDoc?.format).toBe('hvl');
    expect(currentAhxSource()).toEqual(expected);
  });
});

describe('exporting an HVL song (the HVL row)', () => {
  it('writes the embedded file, not the stale source record', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    const file = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    attachAhxSource(file, MELTWATER);
    expect(describeSongExporter(hvlExporter, file)).toEqual({ state: 'enabled' });
    const out = hvlExporter.serialize(file);
    expect(out).toEqual(embedded(file));
    expect(stepAt(out, 9)).toMatchObject({ instrument: 1 });
    expect(parseAhx(out).instrumentNr).toBe(10);
  });

  it('a saved .cmod exports straight from its file (no store)', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    const file = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    expect(hvlExporter.check(file)).toEqual({ ok: true });
    expect(hvlExporter.serialize(file)).toEqual(embedded(file));
  });

  it('through the dialog path (snapshotEditorSong) an untouched song exports as its source, byte for byte', async () => {
    const store = await openHvl(MELTWATER);
    expect(hvlExporter.serialize(snapshotEditorSong(store))).toEqual(MELTWATER);
  });

  it('a fresh import with an untouched title exports its source bytes, with no rebuild', () => {
    const song = importAhxToTrackerSong(toBuffer(MELTWATER));
    expect(hvlExporter.serialize(song)).toEqual(MELTWATER);
  });

  it('an embedded AHX file is not an HVL song', async () => {
    const karma = demo('karma.ahx');
    const hvl = importAhxToTrackerSong(toBuffer(MELTWATER));
    const file = { ...hvl, data: { ...hvl.data, ahxFile: encodeAhxFile(karma) } };
    expect(hvlExporter.check(file)).toEqual({ ok: false, reason: "AHX songs can't be saved as HVL." });
  });
});

describe('the AHX row never writes HVL bytes', () => {
  it('an embedded HVL file that does not fit AHX is refused with the conversion reason', async () => {
    const store = await openHvl(MELTWATER);
    editCell(store, 9);
    const file = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    const verdict = describeSongExporter(ahxExporter, file);
    expect(verdict).toEqual({
      state: 'unavailable',
      reason: 'AHX files have 4 tracks; this song reaches track 10. Export it as HVL instead.',
    });
    expect(() => ahxExporter.serialize(file)).toThrow('AHX files have 4 tracks');
  });

  it('an embedded HVL file that fits is converted, edits included, and the output is a THX file', async () => {
    const model = fittingHvlModel();
    const store = await openHvl(serializeAhx(model));
    editCell(store, 0);
    const file = JSON.parse(JSON.stringify(store.serializeSong())) as TrackerSongFile;
    expect(describeSongExporter(ahxExporter, file)).toEqual({ state: 'enabled' });
    const out = ahxExporter.serialize(file);
    expect([out[0], out[1], out[2]]).toEqual([0x54, 0x48, 0x58]);
    expect(parseAhx(out).format).toBe('ahx');
    expect(stepAt(out, 0)).toMatchObject({ instrument: 1 });
    expect(stepAt(out, 0)).toEqual(stepAt(embedded(file), 0));
  });
});

describe('an HVL song with no name', () => {
  it('the synthetic fixture has an empty name and imports as "Imported HVL"', () => {
    const bytes = namelessHvl();
    expect(parseAhx(bytes).name).toBe('');
    expect(importAhxToTrackerSong(toBuffer(bytes)).data.currentSong.title).toBe('Imported HVL');
  });

  it('the bytes an edit publishes to the engine keep the empty name (the rebuild, not the save)', async () => {
    const store = await openHvl(namelessHvl());
    editCell(store, 0);
    expect(parseAhx(currentAhxSource()!).name).toBe('');
  });

  it('an edit does not write the "Imported HVL" fallback into the file: the name stays empty', async () => {
    const store = await openHvl(namelessHvl());
    expect(store.currentSong.title).toBe('Imported HVL');
    editCell(store, 0);
    const bytes = embedded(store.serializeSong());
    expect(stepAt(bytes, 0)).toMatchObject({ instrument: 1 });
    expect(parseAhx(bytes).name).toBe('');
    expect(parseAhx(currentAhxSource()!).name).toBe('');
    expect(parseAhx(hvlExporter.serialize(snapshotEditorSong(store))).name).toBe('');
    expect(buildAhxFile({ doc: store.ahxDoc!, slots: [], title: 'Imported HVL' }).titleAltered).toBe(false);
  });

  it('a title the user typed is written, even one that reads "Imported AHX"', async () => {
    const store = await openHvl(namelessHvl());
    store.currentSong.title = 'Imported AHX';
    expect(parseAhx(embedded(store.serializeSong())).name).toBe('Imported AHX');
  });
});

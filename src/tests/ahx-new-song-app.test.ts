import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx } from '@another-synth/tracker-playback';
import { useTrackerStore, type TrackerSongFile } from 'src/stores/tracker-store';
import { useTrackerFileIO, type TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import type { TrackerSongBank } from 'src/audio/tracker/song-bank';
import { currentAhxSource, setCurrentAhxSource } from 'src/audio/tracker/ahx-source';
import {
  HVL_MAX_CHANNELS,
  NEW_AHX_SONG_NAME,
  NEW_HVL_DEFSTEREO,
  NEW_HVL_SONG_NAME,
  buildAhxFile,
  createNewAhxDoc,
  createNewHvlDoc,
  decodeAhxFile,
  docFromBytes,
  newHvlMixgain,
} from 'src/audio/tracker/ahx-doc';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';
import { AHX_PRESETS } from 'src/audio/tracker/ahx-presets';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { ahxExporter, describeSongExporter, hvlExporter } from 'src/audio/tracker/song-export';
import { clearLoadedSongHash, getLoadedSongHash, recordLoadedSongHash } from 'src/composables/song-identity';
import { plainDoc } from './helpers/ahx-doc-fixtures';
import { peak, renderAhx } from './helpers/ahx-render';

/**
 * A new AHX or HVL song from the New Song dialog (`resetToNewAhxSong`): the
 * song is a file loaded the way an opened `.ahx`/`.hvl` is, so it has its doc,
 * its slots and its bytes installed for the engine; it starts with the
 * editor's default instrument, takes presets, plays, saves as a `.cmod` that
 * opens again as the same song, and exports. The songs go through the real
 * store and the real `useTrackerFileIO` (`applyNewSong`, the page's path).
 */

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
  return { io: useTrackerFileIO(ctx), saved, notify };
}

/** The New Song dialog's AHX/HVL choice, as TrackerPage's `createNewSong` applies it. */
async function newSong(format: 'ahx' | 'hvl', options: Parameters<Store['resetToNewAhxSong']>[1] = {}): Promise<Store> {
  const store = useTrackerStore();
  await fileIO(store).io.applyNewSong(() => store.resetToNewAhxSong(format, options));
  return store;
}

/** A note on channel `channel`, row `row` of position 0, through the grid's write-back (as typing one does). */
function writeNote(store: Store, channel: number, row: number, note: string, instrument: string): void {
  const cell = store.patterns[0]!.tracks[channel]!;
  cell.entries = [...cell.entries.filter((e) => e.row !== row), { row, note, instrument }];
  store.syncAhxWriteBack();
}

const blobBytes = (blob: Blob): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

const embedded = (file: TrackerSongFile): Uint8Array => {
  const decoded = decodeAhxFile(file.data.ahxFile);
  if (!decoded.ok) throw new Error(`no usable ahxFile: ${decoded.reason}`);
  return decoded.bytes;
};

const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
  clearAhxEditNotice();
  clearLoadedSongHash();
  vi.unstubAllGlobals();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('createNewHvlDoc', () => {
  it('is the new AHX song, as HVL, across the chosen channels', () => {
    const doc = createNewHvlDoc({ channels: 7, trackLength: 16, speedMultiplier: 2 });
    const ahx = createNewAhxDoc({ trackLength: 16, speedMultiplier: 2 });
    expect(doc.format).toBe('hvl');
    expect(doc.version).toBe(1);
    expect(doc.songName).toBe(NEW_HVL_SONG_NAME);
    expect(doc.channels).toBe(7);
    expect(doc.positions).toEqual([{ track: [1, 0, 0, 0, 0, 0, 0], transpose: [0, 0, 0, 0, 0, 0, 0] }]);
    expect(doc.tracks).toEqual(ahx.tracks);
    expect([doc.trackLength, doc.speedMultiplier, doc.restart]).toEqual([16, 2, 0]);
    expect(doc.instruments).toEqual([]);
    expect(doc.defstereo).toBe(NEW_HVL_DEFSTEREO);
    expect(doc.base).toBeUndefined();
    expect(Object.isFrozen(doc)).toBe(true);
  });

  it('is as loud at 4 channels as a new AHX song (the engine\'s AHX gain at stereo 2), and quieter the wider it is', () => {
    expect(newHvlMixgain(4)).toBe(76);
    expect(newHvlMixgain(16)).toBe(38);
    for (let n = 5; n <= HVL_MAX_CHANNELS; n++) expect(newHvlMixgain(n)).toBeLessThan(newHvlMixgain(n - 1));
  });

  it('refuses a channel count HVL cannot hold, saying which', () => {
    expect(() => createNewHvlDoc({ channels: 3 })).toThrow('A new HVL song has 4 to 16 channels (got 3).');
    expect(() => createNewHvlDoc({ channels: 17 })).toThrow('(got 17)');
  });

  it('with its instruments, writes a file that reads back as the same doc', () => {
    for (const channels of [4, 9, 16]) {
      const doc = createNewHvlDoc({ channels, instruments: [defaultAhxInstrument()] });
      const bytes = buildAhxFile({ doc, slots: [], title: doc.songName }).bytes;
      const back = docFromBytes(bytes);
      expect(plainDoc(back)).toEqual(plainDoc(doc));
    }
  });
});

describe('the store\'s new AHX song', () => {
  it('is an editable AHX song with one instrument, the editor\'s default, no history and no file hash', async () => {
    const store = useTrackerStore();
    store.pushHistory();
    recordLoadedSongHash(new Uint8Array([1, 2, 3]).buffer);
    await fileIO(store).io.applyNewSong(() => store.resetToNewAhxSong('ahx', { trackLength: 32, speedMultiplier: 2 }));
    expect(store.moduleFormat).toBe('ahx');
    expect(store.isAhxEditable).toBe(true);
    expect(store.ahxDoc?.format).toBe('ahx');
    expect([store.ahxDoc?.trackLength, store.ahxDoc?.speedMultiplier]).toEqual([32, 2]);
    expect(store.currentSong.title).toBe(NEW_AHX_SONG_NAME);
    expect(store.undoStack).toHaveLength(0);
    expect(getLoadedSongHash()).toBeNull();
    expect(store.instrumentSlots[0]!.ahxData).toEqual(defaultAhxInstrument());
    expect(store.instrumentSlots[0]!.instrumentName).toBe(defaultAhxInstrument().name);
    expect(store.instrumentSlots[1]!.ahxData).toBeUndefined();
    expect(store.patterns.map((p) => [p.rows, p.tracks.length])).toEqual([[32, 4]]);
  });

  it('has its bytes installed for the engine: the store\'s own, the song file of its doc and slots', async () => {
    const store = await newSong('ahx');
    const bytes = currentAhxSource();
    expect(bytes).not.toBeNull();
    expect(bytes).toEqual(store.currentAhxBytes());
    const song = parseAhx(bytes!);
    expect(song.format).toBe('ahx');
    expect(song.instruments.slice(1)).toEqual([defaultAhxInstrument()]);
  });

  it('takes presets ("Add from preset"), plays them, saves as a .cmod that opens again as the same song, and exports', async () => {
    const store = await newSong('ahx');
    const presets = AHX_PRESETS.filter((p) => ['bass-saw', 'drum-kick', 'lead-pwm'].includes(p.id));
    for (const p of presets) expect(store.addAhxPresetInstrument(p.id), p.id).not.toBeNull();
    expect(store.instrumentSlots.slice(0, 4).map((s) => s.instrumentName)).toEqual([defaultAhxInstrument().name, ...presets.map((p) => p.name)]);
    writeNote(store, 0, 0, 'C-3', '02');
    writeNote(store, 1, 4, 'C-4', '04');

    // The engine's bytes follow the edits, and they sound.
    const playing = store.currentAhxBytes()!;
    expect(currentAhxSource()).toEqual(playing);
    expect(peak(renderAhx(playing, 0.5))).toBeGreaterThan(0.05);
    store.currentSong.title = 'First tune';

    // Save, then open the .cmod in a fresh app.
    const { io, saved, notify } = fileIO(store);
    await io.handleSaveSongFile();
    expect(notify).not.toHaveBeenCalled();
    expect(saved).toHaveLength(1);
    const expected = embedded(store.serializeSong());
    const cmod = await blobBytes(saved[0]!);
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    const after = useTrackerStore();
    await fileIO(after).io.loadSongFromFile({ name: 'song.cmod', arrayBuffer: async () => toBuffer(cmod) } as unknown as File);
    expect(after.isAhxEditable).toBe(true);
    expect(after.currentSong.title).toBe('First tune');
    expect(after.currentAhxBytes()).toEqual(expected);
    expect(currentAhxSource()).toEqual(expected);

    // Export writes the same file.
    const file = after.serializeSong();
    expect(describeSongExporter(ahxExporter, file)).toEqual({ state: 'enabled' });
    const out = ahxExporter.serialize(file);
    expect(out).toEqual(expected);
    const song = parseAhx(out);
    expect(song.name).toBe('First tune');
    expect(song.instruments.slice(2).map((ins) => ins.name)).toEqual(presets.map((p) => p.name));
    expect(song.tracks[song.positions[0]!.track[0]!]![0]).toMatchObject({ instrument: 2 });
  });

  it('replaces whatever song was loaded, and a refused option leaves it as it was', async () => {
    const store = await newSong('ahx', { trackLength: 16 });
    const doc = store.ahxDoc;
    expect(() => store.resetToNewAhxSong('hvl', { channels: 17 })).toThrow('(got 17)');
    expect(store.ahxDoc).toBe(doc);
    store.resetToNewSidSong();
    expect(store.ahxDoc).toBeNull();
    store.resetToNewAhxSong('ahx');
    expect(store.moduleFormat).toBe('ahx');
    expect(store.sidDoc).toBeNull();
  });
});

describe('the store\'s new HVL song', () => {
  it('is an editable HVL song of the chosen width, holding the default instrument, and the engine plays its file', async () => {
    const store = await newSong('hvl', { channels: 8, trackLength: 48, speedMultiplier: 3 });
    const doc = store.ahxDoc;
    expect(doc?.format).toBe('hvl');
    if (doc?.format !== 'hvl') return;
    expect([doc.channels, doc.trackLength, doc.speedMultiplier, doc.mixgainRaw]).toEqual([8, 48, 3, newHvlMixgain(8)]);
    expect(doc.instruments).toEqual([defaultAhxInstrument()]);
    expect(store.isAhxEditable).toBe(true);
    expect(store.currentSong.title).toBe(NEW_HVL_SONG_NAME);
    expect(store.instrumentSlots[0]!.ahxData).toEqual(defaultAhxInstrument());
    expect(store.patterns[0]!.tracks).toHaveLength(8);
    // The engine plays the file the doc was read from (`replaceSong`: an HVL doc's base).
    expect(doc.base).toBeDefined();
    expect(currentAhxSource()).toEqual(doc.base);
  });

  it('takes an HVL-only preset on channel 8, saves, opens again and exports as .hvl', async () => {
    const store = await newSong('hvl', { channels: 8 });
    expect(store.addAhxPresetInstrument('keys-ring-bell')).toBe(2);
    writeNote(store, 7, 0, 'C-4', '02');
    const playing = currentAhxSource()!;
    expect(parseAhx(playing).channels).toBe(8);
    expect(peak(renderAhx(playing, 0.5))).toBeGreaterThan(0.05);

    const { io, saved } = fileIO(store);
    await io.handleSaveSongFile();
    const expected = embedded(store.serializeSong());
    const cmod = await blobBytes(saved[0]!);
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    const after = useTrackerStore();
    await fileIO(after).io.loadSongFromFile({ name: 'song.cmod', arrayBuffer: async () => toBuffer(cmod) } as unknown as File);
    expect(after.ahxDoc?.format).toBe('hvl');
    expect(after.isAhxEditable).toBe(true);
    expect(currentAhxSource()).toEqual(expected);

    const file = after.serializeSong();
    expect(describeSongExporter(hvlExporter, file)).toEqual({ state: 'enabled' });
    const out = hvlExporter.serialize(file);
    expect(out).toEqual(expected);
    const song = parseAhx(out);
    expect([song.format, song.channels, song.instrumentNr]).toEqual(['hvl', 8, 2]);
    expect(song.instruments[2]!.name).toBe('Ring Bell');
  });
});

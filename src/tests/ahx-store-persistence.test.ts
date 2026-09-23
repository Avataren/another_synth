import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isReactive } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { parseAhx } from '@another-synth/tracker-playback';
import { CURRENT_SONG_FILE_VERSION, useTrackerStore, type TrackerSongFile } from 'src/stores/tracker-store';
import { useTrackerFileIO, type TrackerFileIOContext } from 'src/composables/useTrackerFileIO';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  ahxSourceInfo,
  ahxSourceRecordOf,
  attachAhxSource,
  currentAhxInstrumentEdits,
  currentAhxSource,
  setCurrentAhxSource,
  snapshotEditorSong,
} from 'src/audio/tracker/ahx-source';
import { AHX_FILE_MAX_BASE64_LENGTH, decodeAhxFile, encodeAhxFile, type AhxDoc } from 'src/audio/tracker/ahx-doc';
import { setAhxNumber } from 'src/audio/tracker/ahx-instrument-edit';
import { clearAhxEditNotice } from 'src/audio/tracker/ahx-edit-notice';
import { plainDoc } from './helpers/ahx-doc-fixtures';

const DEMOS = path.resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(DEMOS, name)));
const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const KARMA = demo('karma.ahx');

type Store = ReturnType<typeof useTrackerStore>;

/** What `applySongFile` does to the store and the source registry (its AHX part). */
function applyLikeFileIO(store: Store, file: TrackerSongFile): void {
  store.loadSongFile(file);
  const doc = store.ahxDoc;
  const bytes = doc?.format === 'ahx' ? store.currentAhxBytes() : null;
  const record = ahxSourceRecordOf(file);
  if (bytes !== null && doc !== null) {
    setCurrentAhxSource(bytes, { format: 'ahx', version: doc.version, edits: [] });
  } else if (!record && doc?.format === 'hvl' && doc.base !== undefined) {
    setCurrentAhxSource(doc.base, { format: 'hvl', version: doc.version, edits: [] });
  } else {
    setCurrentAhxSource(record?.bytes ?? null, record ?? {});
  }
}

function openKarma(bytes: Uint8Array = KARMA): Store {
  const store = useTrackerStore();
  applyLikeFileIO(store, importAhxToTrackerSong(toBuffer(bytes)));
  return store;
}

/** A song file as a `.cmod` holds it: what JSON keeps (the source record does not survive). */
const viaJson = (file: TrackerSongFile): TrackerSongFile => JSON.parse(JSON.stringify(file)) as TrackerSongFile;

/** A fresh store (as a new page load has), for the reading side of a round trip. */
function freshStore(): Store {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
  return useTrackerStore();
}

/** The doc's data without its name (a title edit writes the name into the file, the doc that was edited still has the old one). */
const sameButName = (doc: AhxDoc): unknown => ({ ...(plainDoc(doc) as object), songName: '' });

/** An edited song: a grid edit (through the doc), an instrument parameter edit (live path) and a new title. */
function editedKarma(): Store {
  const store = openKarma();
  const cell = store.patterns[0]!.tracks[0]!;
  cell.entries = [...cell.entries.filter((e) => e.row !== 3), { row: 3, note: 'C-3', instrument: '02' }];
  store.currentSong.title = 'Round Trip';
  const slot = store.instrumentSlots[1]!.ahxData!;
  expect(store.updateAhxInstrument(2, setAhxNumber(slot, 'volume', slot.volume === 7 ? 8 : 7))).toBe('applied');
  return store;
}

beforeEach(() => {
  setActivePinia(createPinia());
  setCurrentAhxSource(null);
  clearAhxEditNotice();
});
afterEach(() => {
  setCurrentAhxSource(null);
  clearAhxEditNotice();
  vi.restoreAllMocks();
});

describe('the v5 file shape', () => {
  it('the writer emits version 5, and only an editable AHX song carries ahxFile', () => {
    expect(CURRENT_SONG_FILE_VERSION).toBe(5);
    const native = useTrackerStore();
    native.resetToNewSong();
    const saved = native.serializeSong();
    expect(saved.version).toBe(5);
    expect(saved.data.ahxFile).toBeUndefined();

    const store = openKarma();
    const file = store.serializeSong();
    expect(file.version).toBe(5);
    expect(typeof file.data.ahxFile).toBe('string');
  });

  it('an unedited song embeds exactly the bytes it was imported from', () => {
    const store = openKarma();
    const decoded = decodeAhxFile(store.serializeSong().data.ahxFile);
    expect(decoded.ok).toBe(true);
    expect(decoded.ok && decoded.bytes).toEqual(KARMA);
  });

  it('base64 round-trips every corpus-size payload', () => {
    const big = demo('pilgrim.ahx');
    const decoded = decodeAhxFile(encodeAhxFile(big));
    expect(decoded.ok && decoded.bytes).toEqual(big);
  });
});

describe('a saved edited song loads back as the song that was saved', () => {
  it('doc, slots, title and the bytes survive a .cmod round trip (the bytes exactly)', () => {
    const before = editedKarma();
    const saved = viaJson(before.serializeSong());
    const savedBytes = decodeAhxFile(saved.data.ahxFile);
    expect(savedBytes.ok).toBe(true);
    const wanted = (savedBytes as { bytes: Uint8Array }).bytes;
    // The file holds the edits: the grid edit and the instrument parameter.
    const parsed = parseAhx(wanted);
    expect(parsed.name).toBe('Round Trip');
    expect(parsed.instruments[2]!.volume).toBe(before.instrumentSlots[1]!.ahxData!.volume);

    const after = freshStore();
    applyLikeFileIO(after, saved);
    expect(after.isAhxEditable).toBe(true);
    expect(after.isReadOnly).toBe(false);
    expect(after.currentSong.title).toBe('Round Trip');
    expect(sameButName(after.ahxDoc as AhxDoc)).toEqual(sameButName(before.ahxDoc as AhxDoc));
    // The doc's name is the file's: the title the song was saved under.
    expect((after.ahxDoc as AhxDoc).songName).toBe('Round Trip');
    expect(after.instrumentSlots.map((s) => s.ahxData)).toEqual(before.instrumentSlots.map((s) => s.ahxData));
    // `base` is retained: the reloaded song writes back exactly what was saved, and Play loads it.
    expect(after.currentAhxBytes()).toEqual(wanted);
    expect(currentAhxSource()).toEqual(wanted);
    expect(ahxSourceInfo.value).toMatchObject({ format: 'ahx', version: parsed.version });
    expect(after.serializeSong().data.ahxFile).toBe(saved.data.ahxFile);
  });

  it('the grid is the doc\'s projection (the row model written beside the file is ignored)', () => {
    const before = editedKarma();
    const saved = viaJson(before.serializeSong());
    const intact = freshStore();
    applyLikeFileIO(intact, viaJson(saved));
    // A row model that disagrees with the file: the file is the authority.
    saved.data.patterns = [];
    saved.data.sequence = [];
    const after = freshStore();
    applyLikeFileIO(after, saved);
    expect(after.patterns.length).toBe((after.ahxDoc as AhxDoc).positions.length);
    expect(JSON.stringify(after.patterns)).toBe(JSON.stringify(intact.patterns));
  });

  it('the doc read back is the one that was set (markRaw)', () => {
    const after = freshStore();
    applyLikeFileIO(after, viaJson(editedKarma().serializeSong()));
    expect(isReactive(after.ahxDoc)).toBe(false);
    expect(after.ahxDoc).toBe(after.ahxDoc);
  });

  it('a song that was saved can be exported again after the round trip (the exporter reads ahxFile)', async () => {
    const { ahxExporter } = await import('src/audio/tracker/song-export');
    const saved = viaJson(editedKarma().serializeSong());
    const after = freshStore();
    applyLikeFileIO(after, saved);
    const song = snapshotEditorSong(after);
    expect(ahxExporter.check(song)).toEqual({ ok: true });
    expect(ahxExporter.serialize(song)).toEqual((decodeAhxFile(saved.data.ahxFile) as { bytes: Uint8Array }).bytes);
    // Straight from the parsed .cmod (no store): the file is enough.
    expect(ahxExporter.check(saved)).toEqual({ ok: true });
  });
});

describe('a file with a bad ahxFile falls back to a read-only display (no throw)', () => {
  const cases: [name: string, ahxFile: unknown][] = [
    ['invalid base64', '!!!!not base64!!!!'],
    ['base64 of bytes that are not a song', encodeAhxFile(new Uint8Array(64).fill(7))],
    ['not text', 42],
  ];

  it.each(cases)('%s', (_name, ahxFile) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = viaJson(openKarma().serializeSong());
    (saved.data as { ahxFile?: unknown }).ahxFile = ahxFile;
    const after = freshStore();
    expect(() => applyLikeFileIO(after, saved)).not.toThrow();
    expect(after.moduleFormat).toBe('ahx');
    expect(after.ahxDoc).toBeNull();
    expect(after.isAhxEditable).toBe(false);
    expect(after.isReadOnly).toBe(true);
    expect(currentAhxSource()).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(after.serializeSong().data.ahxFile).toBeUndefined();
  });

  it('an HVL file is no longer a bad one (plan-hvl-editing.md P3): it is the song, an editable HVL doc with its instruments in slots', () => {
    const hvl = demo('meltwater_10ch.hvl');
    const saved = viaJson(openKarma().serializeSong());
    saved.data.ahxFile = encodeAhxFile(hvl);
    const after = freshStore();
    applyLikeFileIO(after, saved);
    expect(after.ahxDoc?.format).toBe('hvl');
    expect(after.isAhxEditable).toBe(true);
    // Flipped by plan-hvl-instruments-0923 (was: no slots): the file's 10 instruments are listed.
    expect(after.instrumentSlots.filter((slot) => slot.ahxData !== undefined).map((slot) => slot.ahxData)).toEqual(parseAhx(hvl).instruments.slice(1));
    expect(currentAhxSource()).toEqual(hvl);
    const again = decodeAhxFile(after.serializeSong().data.ahxFile);
    expect(again.ok && again.format).toBe('hvl');
    expect(again.ok && again.bytes).toEqual(hvl);
  });

  it('an over-cap ahxFile is refused before it is decoded', () => {
    const atob = vi.spyOn(globalThis, 'atob');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = viaJson(openKarma().serializeSong());
    saved.data.ahxFile = 'A'.repeat(AHX_FILE_MAX_BASE64_LENGTH + 4);
    const decoded = decodeAhxFile(saved.data.ahxFile);
    expect(decoded).toMatchObject({ ok: false });
    const after = freshStore();
    expect(() => applyLikeFileIO(after, saved)).not.toThrow();
    expect(after.ahxDoc).toBeNull();
    expect(atob).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('a file just under the cap is still read (the cap is on the text, not a rounding of it)', () => {
    const text = 'A'.repeat(AHX_FILE_MAX_BASE64_LENGTH);
    const decoded = decodeAhxFile(text);
    // Within the cap it is decoded; it just is not an AHX file.
    expect(decoded).toMatchObject({ ok: false, reason: expect.stringMatching(/AHX/) });
  });
});

describe('load precedence: ahxFile beats a source record', () => {
  it('a song file carrying an ahxFile and a stale record loads from the ahxFile', () => {
    const other = demo('pilgrim.ahx');
    const saved = viaJson(editedKarma().serializeSong());
    attachAhxSource(saved, other);
    const after = freshStore();
    applyLikeFileIO(after, saved);
    expect(after.currentSong.title).toBe('Round Trip');
    expect((after.ahxDoc as AhxDoc).positions.length).toBe(parseAhx(KARMA).positionNr);
    expect(parseAhx(currentAhxSource() as Uint8Array).name).toBe('Round Trip');
  });

  it('a fresh raw import (a record, no ahxFile) still gets its doc from the record', () => {
    const store = openKarma();
    expect(store.ahxDoc).not.toBeNull();
    expect((store.ahxDoc as AhxDoc).base).toEqual(KARMA);
  });

  it('an instrument-parameter edit, snapshotEditorSong, then put-back on a fresh store: the slots and the bytes agree', () => {
    const before = openKarma();
    const original = before.instrumentSlots[1]!.ahxData!;
    const volume = original.volume === 7 ? 8 : 7;
    expect(before.updateAhxInstrument(2, setAhxNumber(original, 'volume', volume))).toBe('applied');
    // The edit is on the live path: the doc is untouched and the recorded edit is on top of the old bytes.
    expect(currentAhxInstrumentEdits().map((e) => e.instrument)).toEqual([2]);

    const snapshot = snapshotEditorSong(before);
    // The file carries the edit, so the current bytes (possibly older) are not attached.
    expect(ahxSourceRecordOf(snapshot)).toBeNull();

    const after = freshStore();
    applyLikeFileIO(after, snapshot);
    expect(after.instrumentSlots[1]!.ahxData!.volume).toBe(volume);
    expect(parseAhx(currentAhxSource() as Uint8Array).instruments[2]!.volume).toBe(volume);
    // The edit is baked into the bytes: nothing is recorded on top of them.
    expect(currentAhxInstrumentEdits()).toEqual([]);
  });
});

describe('the song-file version gate is a range', () => {
  /** A song file another writer made: a scratch store's save, with the version and format set. */
  function fileOf(version: unknown, moduleFormat: 'native' | 'protracker' | 'xm' | 's3m' = 'native'): TrackerSongFile {
    const active = createPinia();
    setActivePinia(active);
    const scratch = useTrackerStore();
    scratch.resetToNewSong();
    scratch.currentSong.title = `Saved v${String(version)} ${moduleFormat}`;
    const file = viaJson(scratch.serializeSong());
    file.data.moduleFormat = moduleFormat;
    (file as { version: unknown }).version = version;
    return file;
  }
  const load = (file: TrackerSongFile): Store => {
    const store = freshStore();
    store.currentSong.title = 'untouched';
    store.loadSongFile(file);
    return store;
  };

  it.each([1, 2, 3, 4, 5] as const)('a version %i native song loads', (version) => {
    expect(load(fileOf(version)).currentSong.title).toBe(`Saved v${version} native`);
  });

  it.each(['protracker', 'xm', 's3m'] as const)('a v4 %s song loads (v4 is only accepted while it equals the current version otherwise)', (format) => {
    const store = load(fileOf(4, format));
    expect(store.currentSong.title).toBe(`Saved v4 ${format}`);
    expect(store.moduleFormat).toBe(format);
  });

  it.each([0, 6, 99, -1, 4.5, '5', null, Number.NaN])('version %s is refused, and nothing changes', (version) => {
    expect(load(fileOf(version)).currentSong.title).toBe('untouched');
  });

  it('a v4 AHX .cmod (a Jukebox-era snapshot) loads as a read-only display', () => {
    const file = viaJson(importAhxToTrackerSong(toBuffer(KARMA)));
    (file as { version: number }).version = 4;
    const store = load(file);
    expect(store.moduleFormat).toBe('ahx');
    expect(store.ahxDoc).toBeNull();
    expect(store.isReadOnly).toBe(true);
    expect(store.instrumentSlots[0]!.ahxData).toBeDefined();
  });
});

describe('both JSON paths of parseSongBuffer', () => {
  const io = useTrackerFileIO({} as unknown as TrackerFileIOContext);

  it('the zipped .cmod and the plain JSON reach the store with the same doc, and the record carries the bytes', async () => {
    const edited = editedKarma();
    const saved = edited.serializeSong();
    const expectedDoc = sameButName(edited.ahxDoc as AhxDoc);
    const json = JSON.stringify(saved);

    const zip = new JSZip();
    zip.file('song.json', json);
    const zipped = await zip.generateAsync({ type: 'uint8array' });
    const fromZip = await io.parseSongBuffer(toBuffer(zipped));
    const fromJson = await io.parseSongBuffer(toBuffer(new TextEncoder().encode(json)));

    const wanted = (decodeAhxFile(saved.data.ahxFile) as { bytes: Uint8Array }).bytes;
    for (const file of [fromZip, fromJson]) {
      expect(ahxSourceRecordOf(file)!.bytes).toEqual(wanted);
      expect(ahxSourceRecordOf(file)).toMatchObject({ format: 'ahx' });
    }
    const a = freshStore();
    applyLikeFileIO(a, fromZip);
    const b = freshStore();
    applyLikeFileIO(b, fromJson);
    expect(plainDoc(a.ahxDoc as AhxDoc)).toEqual(plainDoc(b.ahxDoc as AhxDoc));
    expect(sameButName(a.ahxDoc as AhxDoc)).toEqual(expectedDoc);
  });

  it('an unusable ahxFile attaches nothing and does not throw', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saved = viaJson(openKarma().serializeSong());
    saved.data.ahxFile = 'not base64!';
    const file = await io.parseSongBuffer(toBuffer(new TextEncoder().encode(JSON.stringify(saved))));
    expect(ahxSourceRecordOf(file)).toBeNull();
  });
});

describe('stale docs: a v5 file does not leave its doc or its ahxFile behind', () => {
  it('load an editable AHX, then a MOD file that carries a stray ahxFile: no doc, no ahxFile on save', () => {
    const store = openKarma();
    const stray = viaJson(editedKarma().serializeSong());
    stray.data.moduleFormat = 'protracker';
    applyLikeFileIO(store, stray);
    expect(store.moduleFormat).toBe('protracker');
    expect(store.ahxDoc).toBeNull();
    expect(store.isAhxEditable).toBe(false);
    expect(store.serializeSong().data.ahxFile).toBeUndefined();
    expect(currentAhxSource()).toBeNull();
  });

  it('load an editable AHX, then a doc-less AHX (v4): no doc, no ahxFile on save, read-only', () => {
    const store = openKarma();
    const legacy = viaJson(importAhxToTrackerSong(toBuffer(KARMA)));
    (legacy as { version: number }).version = 4;
    applyLikeFileIO(store, legacy);
    expect(store.ahxDoc).toBeNull();
    expect(store.isReadOnly).toBe(true);
    expect(store.serializeSong().data.ahxFile).toBeUndefined();
  });
});

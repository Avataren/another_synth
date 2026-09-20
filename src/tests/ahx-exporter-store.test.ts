import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive, ref } from 'vue';
import { parseAhx, serializeAhxInstrument, type AhxInstrument } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  ahxSourceInfoOf,
  ahxSourceRecordOf,
  currentAhxInstrumentEdits,
  setCurrentAhxSource,
  snapshotEditorSong,
} from 'src/audio/tracker/ahx-source';
import { addAhxPListEntry, setAhxNumber } from 'src/audio/tracker/ahx-instrument-edit';
import { ahxExporter, SongExportError } from 'src/audio/tracker/song-export';

const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(DEMOS, name)));

/** What `applySongFile` does for an AHX song: the store gets the file, `ahx-source` the bytes. */
function openInEditor(bytes: Uint8Array) {
  const store = useTrackerStore();
  store.loadSongFile(importAhxToTrackerSong(bytes.slice().buffer));
  setCurrentAhxSource(bytes.slice(), ahxSourceInfoOf(bytes));
  return store;
}

const exportNow = (store: ReturnType<typeof useTrackerStore>): Uint8Array =>
  ahxExporter.serialize(snapshotEditorSong(store));

/** Byte range of instrument `n`'s 22-byte core + PList, by walking an AHX file's layout. */
function instrumentSpan(bytes: Uint8Array, n: number): [number, number] {
  const song = parseAhx(bytes);
  const stored = song.tracks.length - ((bytes[6] ?? 0) & 0x80 ? 1 : 0);
  let at = 14 + song.subsongNr * 2 + song.positionNr * 8 + stored * song.trackLength * 3;
  for (let i = 1; i < n; i++) at += 22 + (bytes[at + 21] ?? 0) * 4;
  return [at, at + 22 + (bytes[at + 21] ?? 0) * 4];
}

const changedOffsets = (a: Uint8Array, b: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(i);
  return out;
};

const NO_SOURCE = 'This song has no original file to export from.';

describe('the AHX exporter with the real store', () => {
  const source = demo('karma.ahx');
  let store: ReturnType<typeof useTrackerStore>;

  beforeEach(() => {
    setActivePinia(createPinia());
    setCurrentAhxSource(null);
    store = openInEditor(source);
  });

  const slotInstrument = (n: number): AhxInstrument => store.instrumentSlots[n - 1]!.ahxData!;

  it('an instrument edit reaches the file, and a same-length edit changes nothing outside that instrument', () => {
    const before = slotInstrument(1);
    const volume = before.volume === 10 ? 11 : 10;
    expect(store.updateAhxInstrument(1, setAhxNumber(before, 'volume', volume))).toBe('applied');

    const out = exportNow(store);
    const parsed = parseAhx(out);
    expect(parsed.instruments[1]!.volume).toBe(volume);
    expect(out.length).toBe(source.length);
    const [start, end] = instrumentSpan(source, 1);
    const changed = changedOffsets(source, out);
    expect(changed.length).toBeGreaterThan(0);
    for (const offset of changed) expect(offset >= start && offset < end, `byte ${offset} outside ${start}..${end}`).toBe(true);
    // Every other instrument is what the source has.
    const original = parseAhx(source);
    for (let n = 2; n <= original.instrumentNr; n++) expect(parsed.instruments[n]).toEqual(original.instruments[n]);
  });

  it('a length-changing edit shifts what follows it and moves nameOffset', () => {
    const before = slotInstrument(1);
    const longer = addAhxPListEntry(before);
    expect(longer.plist.entries.length).toBe(before.plist.entries.length + 1);
    expect(store.updateAhxInstrument(1, longer)).toBe('applied');

    const out = exportNow(store);
    expect(out.length).toBe(source.length + 4);
    const nameOffset = (b: Uint8Array): number => ((b[4] ?? 0) << 8) | (b[5] ?? 0);
    expect(nameOffset(out)).toBe(nameOffset(source) + 4);
    const parsed = parseAhx(out);
    const original = parseAhx(source);
    expect(parsed.instruments[1]!.plist.entries.length).toBe(before.plist.entries.length + 1);
    for (let n = 2; n <= original.instrumentNr; n++) expect(parsed.instruments[n]).toEqual(original.instruments[n]);
    expect(parsed.name).toBe(original.name);
    expect(parsed.tracks).toEqual(original.tracks);
    expect(parsed.positions).toEqual(original.positions);
  });

  it('the slots and the recorded edits agree for a real edit, so the two cannot drift', () => {
    const before = slotInstrument(2);
    expect(store.updateAhxInstrument(2, setAhxNumber(before, 'volume', before.volume === 7 ? 8 : 7))).toBe('applied');
    const song = snapshotEditorSong(store);
    const edits = ahxSourceRecordOf(song)!.edits!;
    expect(edits.map((e) => e.instrument)).toEqual([2]);
    expect(edits[0]!.bytes).toEqual(serializeAhxInstrument(song.data.instrumentSlots[1]!.ahxData!, 'ahx'));
    expect(currentAhxInstrumentEdits()[0]!.bytes).toEqual(edits[0]!.bytes);
  });

  it('an edited title becomes the song name and nothing else in the file moves', () => {
    store.currentSong.title = 'My Remix';
    const parsed = parseAhx(exportNow(store));
    expect(parsed.name).toBe('My Remix');
    expect({ ...parsed, name: '' }).toEqual({ ...parseAhx(source), name: '' });
  });

  it('renaming an instrument in the slot list reaches the file, and nothing else in it moves', () => {
    store.setInstrumentName(1, '  Renamed Lead  ');
    expect(slotInstrument(1).name).toBe('Renamed Lead');
    const parsed = parseAhx(exportNow(store));
    expect(parsed.instruments[1]!.name).toBe('Renamed Lead');
    const original = parseAhx(source);
    expect({ ...parsed.instruments[1]!, name: '' }).toEqual({ ...original.instruments[1]!, name: '' });
    for (let n = 2; n <= original.instrumentNr; n++) expect(parsed.instruments[n]).toEqual(original.instruments[n]);
  });

  it('an unchanged name is not a rename: an unnamed instrument keeps its empty name in the exported file', () => {
    const unnamed = demo('64k_is_all_you_need.ahx');
    const original = parseAhx(unnamed);
    expect(original.instruments[4]!.name).toBe('');
    store = openInEditor(unnamed);
    // Import seeds the slot with the fallback, which the file never had.
    expect(store.instrumentSlots[3]!.instrumentName).toBe('Instrument 04');
    store.setInstrumentName(4, '  Instrument 04 ');
    expect(slotInstrument(4).name).toBe('');
    expect(exportNow(store)).toEqual(unnamed);
  });

  it('an instrument name the format cannot hold is repaired with a warning, not a failed export', () => {
    store.setInstrumentName(2, 'Lead \u20ac\u{1f600}');
    const song = snapshotEditorSong(store);
    expect(ahxExporter.warnings!(song)).toEqual([
      "Some characters in an instrument name can't be saved and are replaced or removed.",
    ]);
    expect(parseAhx(ahxExporter.serialize(song)).instruments[2]!.name).toBe('Lead ??');
  });

  it('a song file seen through a reactive wrapper still finds its source bytes (the WeakMap is keyed by identity)', () => {
    const song = snapshotEditorSong(store);
    expect(ahxSourceRecordOf(reactive(song) as typeof song)).not.toBeNull();
    expect(ref(song).value === song).toBe(false); // the wrapper really is a different object
    expect(ahxExporter.check(ref(song).value)).toEqual({ ok: true });
    expect(ahxExporter.serialize(ref(song).value)).toEqual(ahxExporter.serialize(song));
  });

  it('an untouched title keeps the file name as it is', () => {
    expect(parseAhx(exportNow(store)).name).toBe(parseAhx(source).name);
  });

  it('a title the format cannot hold has NUL removed and characters above U+00FF replaced', () => {
    store.currentSong.title = 'A\u0000B\u20ac\u{1f600}\u00e9';
    const song = snapshotEditorSong(store);
    expect(ahxExporter.warnings!(song)).toEqual([
      "Some characters in the title can't be saved and are replaced or removed.",
    ]);
    expect(parseAhx(ahxExporter.serialize(song)).name).toBe('AB??\u00e9');
  });

  it('a title that fits gets no warning', () => {
    store.currentSong.title = 'Plain title \u00e9';
    expect(ahxExporter.warnings!(snapshotEditorSong(store))).toEqual([]);
    expect(ahxExporter.warnings!(snapshotEditorSong(openInEditor(source)))).toEqual([]);
  });

  it('author and bpm have no AHX home: changing them changes no byte', () => {
    const same = exportNow(store);
    store.currentSong.author = 'Somebody Else';
    store.currentSong.bpm = 77;
    expect(exportNow(store)).toEqual(same);
    expect(same).toEqual(source);
  });

  it('says author and bpm are not saved only when one of them was changed', () => {
    expect(ahxExporter.warnings!(snapshotEditorSong(store))).toEqual([]);
    store.currentSong.bpm = 77;
    expect(ahxExporter.warnings!(snapshotEditorSong(store))).toEqual(["Author and BPM changes aren't saved."]);
    store.currentSong.bpm = 125;
    store.currentSong.author = 'Somebody Else';
    expect(ahxExporter.warnings!(snapshotEditorSong(store))).toEqual(["Author and BPM changes aren't saved."]);
  });

  it('a song made in the editor from scratch is refused with a plain line, not exported', () => {
    store.moduleFormat = 'native';
    const song = snapshotEditorSong(store);
    expect(ahxExporter.check(song)).toEqual({ ok: false, reason: "Songs made from scratch can't be exported yet." });
    expect(() => ahxExporter.serialize(song)).toThrow("Songs made from scratch can't be exported yet.");
  });

  it('is loadable by our own importer: the patterns, slots and title survive a re-import', () => {
    const before = slotInstrument(1);
    store.updateAhxInstrument(1, setAhxNumber(before, 'volume', before.volume === 10 ? 11 : 10));
    store.currentSong.title = 'Round Trip';
    const out = exportNow(store);

    const back = importAhxToTrackerSong(out.slice().buffer);
    const original = importAhxToTrackerSong(source.slice().buffer);
    expect(back.data.currentSong.title).toBe('Round Trip');
    // Pattern ids are fresh on every import; the rows are what has to survive.
    const rows = (song: typeof back) => song.data.patterns.map(({ id: _id, ...rest }) => rest);
    expect(rows(back)).toEqual(rows(original));
    expect(back.data.sequence.length).toBe(original.data.sequence.length);
    expect(back.data.instrumentSlots[0]!.ahxData).toEqual(store.instrumentSlots[0]!.ahxData);
    expect(back.data.instrumentSlots[1]!.ahxData).toEqual(original.data.instrumentSlots[1]!.ahxData);
    // Exporting what was just re-imported gives the same file back.
    setCurrentAhxSource(null);
    expect(exportNow(openInEditor(out))).toEqual(out);
  });

  it('a song whose bytes are gone (an edit was only kept, or it came from a saved file) is unavailable', () => {
    setCurrentAhxSource(null);
    expect(store.updateAhxInstrument(1, setAhxNumber(slotInstrument(1), 'volume', 5))).toBe('kept');
    const song = snapshotEditorSong(store);
    expect(ahxSourceRecordOf(song)).toBeNull();
    expect(ahxExporter.check(song)).toEqual({ ok: false, reason: NO_SOURCE });
    expect(() => ahxExporter.serialize(song)).toThrow(SongExportError);
    expect(ahxExporter.warnings!(song)).toEqual([]);

    // A .cmod round trip: the file holds the slots but not the bytes.
    const saved = JSON.parse(JSON.stringify(store.serializeSong()));
    setActivePinia(createPinia());
    const fromSaved = useTrackerStore();
    fromSaved.loadSongFile(saved);
    expect(fromSaved.moduleFormat).toBe('ahx');
    expect(ahxExporter.check(snapshotEditorSong(fromSaved))).toEqual({ ok: false, reason: NO_SOURCE });
  });

  it.each([
    ['protracker', 'MOD'],
    ['xm', 'XM'],
    ['s3m', 'S3M'],
  ] as const)('a %s song is unavailable, whatever bytes are current', (format, name) => {
    store.moduleFormat = format;
    const song = snapshotEditorSong(store);
    const reason = `${name} songs can't be saved as AHX.`;
    expect(ahxExporter.check(song)).toEqual({ ok: false, reason });
    expect(() => ahxExporter.serialize(song)).toThrow(reason);
  });

  it('an instrument slot without data, or with invalid data, is a SongExportError, never a partial file', () => {
    const missing = snapshotEditorSong(store);
    delete missing.data.instrumentSlots[0]!.ahxData;
    expect(() => ahxExporter.serialize(missing)).toThrow(/Instrument 1 is missing/);

    const invalid = snapshotEditorSong(store);
    invalid.data.instrumentSlots[2]!.ahxData!.volume = 999;
    let caught: unknown;
    try {
      ahxExporter.serialize(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SongExportError);
    expect((caught as Error).message).toMatch(/^Instrument 3 can't be saved: /);
  });

  it('a song past the 16-bit size limit is a SongExportError carrying the writer reason', () => {
    // pilgrim.ahx is 40742 bytes with 31 instruments; every PList filled to 255 rows is ~72 kB.
    const big = openInEditor(demo('pilgrim.ahx'));
    for (const slot of big.instrumentSlots) {
      if (!slot.ahxData) continue;
      let ins = slot.ahxData;
      while (ins.plist.entries.length < 255) ins = addAhxPListEntry(ins);
      expect(big.updateAhxInstrument(slot.slot, ins)).toBe('applied');
    }
    let caught: unknown;
    try {
      exportNow(big);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SongExportError);
    expect((caught as Error).message).toMatch(/song too large/);
  });
});

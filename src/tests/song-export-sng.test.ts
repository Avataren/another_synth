import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { encodeSidFile, importGtSong, type SidDoc } from 'src/audio/tracker/sid-doc';
import { newSidInstrument } from 'src/audio/tracker/sid-instrument-edit';
import { importGtSongToTrackerSong } from 'src/audio/tracker/sid-import';
import { describeSongExporter, SNG_TEXT_NOTE, sngExporter, SongExportError } from 'src/audio/tracker/song-export';

/**
 * plan-sid-authoring.md phase 1: the export dialog's `.sng` row. The doc a
 * SID song carries (`data.sidFile`) is written by `exportGtSong`, with the
 * store's title and author on it when they were edited; what the writer
 * refuses is the row's reason, what it notes are the row's warnings.
 */

const FIXTURES = resolve(__dirname, 'fixtures/gt-songs');
const bytesOf = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(FIXTURES, name)));
const songOf = (name: string): TrackerSongFile => {
  const b = bytesOf(name);
  return importGtSongToTrackerSong(b.slice().buffer, name.replace(/^.*\//, ''));
};
const docOf = (bytes: Uint8Array): SidDoc => {
  const imported = importGtSong(bytes);
  if (!imported.ok) throw new Error(imported.reason);
  return imported.doc;
};
const withDoc = (song: TrackerSongFile, doc: SidDoc): TrackerSongFile => ({ ...song, data: { ...song.data, sidFile: encodeSidFile(doc) } });
const withTexts = (song: TrackerSongFile, title: string, author = song.data.currentSong.author): TrackerSongFile => ({
  ...song,
  data: { ...song.data, currentSong: { ...song.data.currentSong, title, author } },
});

const PROOF = 'mch/alien_funk.sng';

describe('the .sng exporter', () => {
  it('writes an untouched GTS5 song as a .sng that imports as the same doc', () => {
    const song = songOf(PROOF);
    expect(describeSongExporter(sngExporter, song)).toEqual({ state: 'enabled' });
    // Not the same bytes: the writer encodes orderlists its own (shorter) way.
    expect(docOf(sngExporter.serialize(song))).toEqual(docOf(bytesOf(PROOF)));
  });

  it("warns that the chip model (and a multispeed song's speed) is not in a .sng", () => {
    expect(sngExporter.warnings?.(songOf(PROOF))).toEqual([
      'The chip model (6581) is not stored in a .sng: GoatTracker takes it from its -E option.',
    ]);
    expect(sngExporter.warnings?.(songOf('cadaver/mw_title_remix_2x_speed.sng'))).toContain(
      'The 2x speed is not stored in a .sng: play it in GoatTracker with -S2.',
    );
  });

  it('writes a GoatTracker 1 song as GTS5, which imports as the same doc', () => {
    const song = songOf('cadaver/dojo.sng');
    const out = sngExporter.serialize(song);
    expect(String.fromCharCode(...out.subarray(0, 4))).toBe('GTS5');
    const back = docOf(out);
    const original = docOf(bytesOf('cadaver/dojo.sng'));
    // Dojo's name is empty: the title the import showed (its file name) becomes its name.
    expect(back).toEqual({ ...original, songName: song.data.currentSong.title });
  });

  it("writes the doc's edits: a new instrument exports and imports back", () => {
    const song = songOf(PROOF);
    const added = newSidInstrument(docOf(bytesOf(PROOF)), 'new one');
    if (!added.ok) throw new Error(added.reason);
    const back = docOf(sngExporter.serialize(withDoc(song, added.doc)));
    expect(back).toEqual(added.doc);
    expect(back.instruments.at(-1)?.name).toBe('new one');
  });

  it('writes an edited title and author into the name fields, latin-1 and at most 32 characters', () => {
    const song = songOf(PROOF);
    const edited = docOf(sngExporter.serialize(withTexts(song, 'New Title', 'Someone')));
    expect([edited.songName, edited.author]).toEqual(['New Title', 'Someone']);
    expect(sngExporter.warnings?.(withTexts(song, 'New Title'))).not.toContain(SNG_TEXT_NOTE);

    const long = withTexts(song, `Caf${String.fromCharCode(233)} ${String.fromCharCode(0x30c6)} ${'x'.repeat(40)}`);
    expect(docOf(sngExporter.serialize(long)).songName).toBe(`Caf${String.fromCharCode(233)} ? ${'x'.repeat(25)}`);
    expect(sngExporter.warnings?.(long)?.[0]).toBe(SNG_TEXT_NOTE);
  });

  it("states the writer's refusal as the row's reason, and serialize throws it", () => {
    const song = songOf(PROOF);
    const fast = withDoc(song, { ...docOf(bytesOf(PROOF)), tempo: 4 });
    const reason =
      "This song can't be saved as a .sng: a .sng has no tempo field (GoatTracker starts every song at tempo 6) and this song starts at tempo 4; put an F command with the tempo on its first row instead.";
    expect(describeSongExporter(sngExporter, fast)).toEqual({ state: 'unavailable', reason });
    expect(sngExporter.warnings?.(fast)).toEqual([]);
    expect(() => sngExporter.serialize(fast)).toThrow(SongExportError);
    expect(() => sngExporter.serialize(fast)).toThrow(reason);
  });

  it('refuses a SID song without readable song data', () => {
    const song = songOf(PROOF);
    const data = { ...song.data };
    delete data.sidFile;
    expect(describeSongExporter(sngExporter, { ...song, data })).toEqual({
      state: 'unavailable',
      reason: 'This song has no SID song data to export.',
    });
    expect(describeSongExporter(sngExporter, { ...song, data: { ...data, sidFile: '!!' } })).toEqual({
      state: 'unavailable',
      reason: "This song's SID data can't be read: it is not valid base64.",
    });
  });
});

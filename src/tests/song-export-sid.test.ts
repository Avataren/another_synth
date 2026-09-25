import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { encodeSidFile, importGtSong, type SidDoc } from 'src/audio/tracker/sid-doc';
import { importGtSongToTrackerSong } from 'src/audio/tracker/sid-import';
import { describeSongExporter, SID_TEXT_NOTE, sidExporter, SongExportError } from 'src/audio/tracker/song-export';
import { readPsidHeader } from './helpers/cpu6502';

/**
 * plan-sid-authoring.md phase 4: the export dialog's `.sid` row. It writes
 * the doc a SID song carries (with an edited title/author, like the `.sng`
 * row) through `exportSid`; the packer's refusals are the row's reason, the
 * places GoatTracker's C64 player and this app part are its warnings.
 */

const SONGS = resolve(__dirname, 'fixtures/gt-songs');
const songOf = (name: string): TrackerSongFile => {
  const b = new Uint8Array(readFileSync(resolve(SONGS, name)));
  return importGtSongToTrackerSong(b.slice().buffer, name.replace(/^.*\//, ''));
};
const docOf = (name: string): SidDoc => {
  const r = importGtSong(new Uint8Array(readFileSync(resolve(SONGS, name))));
  if (!r.ok) throw new Error(r.reason);
  return r.doc;
};
const withDoc = (song: TrackerSongFile, doc: SidDoc): TrackerSongFile => ({ ...song, data: { ...song.data, sidFile: encodeSidFile(doc) } });

describe('the .sid exporter', () => {
  it("writes a SID song as GoatTracker's own .sid of it", () => {
    const song = songOf('mch/alien_funk.sng');
    expect(describeSongExporter(sidExporter, song)).toEqual({ state: 'enabled' });
    expect(sidExporter.warnings?.(song)).toEqual([]);
    expect(sidExporter.serialize(song)).toEqual(new Uint8Array(readFileSync(resolve(__dirname, 'fixtures/gt-sids/alien_funk.sid'))));
  });

  it('shows where the C64 player plays the song differently, as sentences', () => {
    expect(sidExporter.warnings?.(songOf('stinsen/sniff.sng'))).toEqual([
      "Pulse table row 58 has a modulation time of 0: here the app (like GoatTracker's editor) holds the pulse, but the C64 player sweeps it for 256 frames.",
    ]);
  });

  it('writes an edited title and author into the header, and notes what did not fit', () => {
    const song = songOf('mch/alien_funk.sng');
    const edited: TrackerSongFile = {
      ...song,
      data: { ...song.data, currentSong: { ...song.data.currentSong, title: 'A new name', author: 'x'.repeat(40) } },
    };
    const h = readPsidHeader(sidExporter.serialize(edited));
    expect([h.name, h.author]).toEqual(['A new name', 'x'.repeat(32)]);
    expect(sidExporter.warnings?.(edited)).toEqual([SID_TEXT_NOTE]);
  });

  it("states the packer's refusal as the row's reason, and serialize throws it", () => {
    const song = songOf('mch/alien_funk.sng');
    const doc = docOf('mch/alien_funk.sng');
    const bad = withDoc(song, { ...doc, tables: { ...doc.tables, wave: [{ left: 0xf0, right: 0 }, ...doc.tables.wave.slice(1)] } });
    const reason =
      "This song can't be exported as a .sid: wave table row 1 has command $F0, which GoatTracker's packer refuses in a wave table (only its editor plays it).";
    expect(describeSongExporter(sidExporter, bad)).toEqual({ state: 'unavailable', reason });
    expect(sidExporter.warnings?.(bad)).toEqual([]);
    expect(() => sidExporter.serialize(bad)).toThrow(SongExportError);
    expect(() => sidExporter.serialize(bad)).toThrow(reason);
  });

  it('refuses songs that are not SID songs', () => {
    const song = songOf('mch/alien_funk.sng');
    expect(describeSongExporter(sidExporter, { ...song, data: { ...song.data, moduleFormat: 'native' } })).toEqual({
      state: 'unavailable',
      reason: "Songs made from scratch can't be exported yet.",
    });
    expect(describeSongExporter(sidExporter, { ...song, data: { ...song.data, moduleFormat: 'ahx' } })).toEqual({
      state: 'unavailable',
      reason: "AHX and HVL songs can't be exported as a C64 .sid.",
    });
  });
});

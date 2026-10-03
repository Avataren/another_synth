import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseMod } from '@another-synth/tracker-playback';
import { createNewModTrackerSong, importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { modExporter, planModExport } from 'src/audio/tracker/song-export/mod-exporter';
import { SONG_EXPORTERS, describeSongExporter } from 'src/audio/tracker/song-export/registry';

const DIR = resolve(__dirname, '../../public/demos/amiga');
const FILES = ['think_twice_iii.mod', 'sound.mod', 'street_jungle.mod', 'arcane.mod', 'variations.mod', 'darkangl.mod', 'h0ffman_-_eon.mod'];

function load(file: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(DIR, file)));
}

describe('mod exporter', () => {
  for (const file of FILES) {
    it(`writes ${file} back as the same song`, () => {
      const original = parseMod(load(file));
      const song = importModToTrackerSong(load(file).slice().buffer);
      const plan = planModExport(song);
      expect('error' in plan).toBe(false);
      const bytes = modExporter.serialize(song);
      const again = parseMod(bytes);

      expect(again.numChannels).toBe(original.numChannels);
      expect(again.songLength).toBe(original.songLength);
      for (let o = 0; o < original.songLength; o++) {
        const a = original.patterns[original.orders[o]!]!;
        const b = again.patterns[again.orders[o]!]!;
        expect(JSON.stringify(b.rows), `order ${o}`).toBe(JSON.stringify(a.rows));
      }
      original.samples.forEach((s, i) => {
        const t = again.samples[i]!;
        expect(t.name).toBe(s.name);
        expect(t.volume).toBe(s.volume);
        expect(t.finetune).toBe(s.finetune);
        expect(Buffer.from(t.data).equals(Buffer.from(s.data)), `sample ${i + 1} data`).toBe(true);
        if (s.loopLength > 2 && s.loopStart + s.loopLength <= s.length) {
          expect([t.loopStart, t.loopLength]).toEqual([s.loopStart, s.loopLength]);
        }
      });
    });
  }

  it('lists only ProTracker songs for .mod', () => {
    const song = importModToTrackerSong(load('sound.mod').slice().buffer);
    expect(describeSongExporter(modExporter, song).state).toBe('enabled');
    song.data.moduleFormat = 'xm';
    expect(describeSongExporter(modExporter, song).state).toBe('unavailable');
    expect(SONG_EXPORTERS).toContain(modExporter);
  });

  it('exports a new module as a valid empty .mod', () => {
    const song = createNewModTrackerSong();
    const bytes = modExporter.serialize(song);
    const mod = parseMod(bytes);
    expect(mod.numChannels).toBe(4);
    expect(mod.signature).toBe('M.K.');
    expect(mod.songLength).toBe(1);
    expect(bytes.length).toBe(1084 + 1024);
  });

  it('derives cells for rows authored here', () => {
    const song = createNewModTrackerSong();
    const pattern = song.data.patterns[0]!;
    pattern.tracks[0]!.entries.push(
      { row: 0, note: 'C-2', instrument: '01', volume: '80' },
      { row: 4, note: 'D-2', macro: 'A04' },
      { row: 8, note: '###' },
    );
    const mod = parseMod(modExporter.serialize(song));
    const rows = mod.patterns[0]!.rows;
    expect(rows[0]![0]).toEqual({ period: 428, sampleNumber: 1, effectCmd: 0xc, effectParam: 32 });
    expect(rows[4]![0]).toEqual({ period: 381, sampleNumber: 0, effectCmd: 0xa, effectParam: 4 });
    expect(rows[8]![0]).toEqual({ period: 0, sampleNumber: 0, effectCmd: 0xe, effectParam: 0xc0 });
  });
});

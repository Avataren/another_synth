import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseXm } from '@another-synth/tracker-playback';
import { createNewXmTrackerSong, importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { planXmExport, xmExporter } from 'src/audio/tracker/song-export/xm-exporter';
import { SONG_EXPORTERS, describeSongExporter } from 'src/audio/tracker/song-export/registry';

const DIR = resolve(__dirname, '../../public/demos/ft2');
// Small files covering: multi-sample keymaps, 16-bit data, the Amiga frequency table.
const FILES = ['artificial_sweetener.xm', '0-kru.xm', '118in64.xm', 'christms.xm', '70sporn.xm'];

function load(file: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(DIR, file)));
}

describe('xm exporter', () => {
  for (const file of FILES) {
    it(`writes ${file} back as the same song`, () => {
      const original = parseXm(load(file));
      const song = importXmToTrackerSong(load(file).slice().buffer);
      expect('error' in planXmExport(song)).toBe(false);
      const again = parseXm(xmExporter.serialize(song));

      expect(again.title).toBe(original.title);
      expect(again.numChannels).toBe(original.numChannels);
      expect(again.songLength).toBe(original.songLength);
      expect(again.linearFrequency).toBe(original.linearFrequency);
      expect(again.defaultSpeed).toBe(original.defaultSpeed);
      expect(again.defaultBpm).toBe(original.defaultBpm);
      for (let o = 0; o < original.songLength; o++) {
        const a = original.patterns[original.orders[o]!]!;
        const b = again.patterns[again.orders[o]!]!;
        expect(b.numRows, `order ${o} rows`).toBe(a.numRows);
        expect(JSON.stringify(b.rows), `order ${o}`).toBe(JSON.stringify(a.rows));
      }
      original.instruments.forEach((ins, i) => {
        const t = again.instruments[i];
        if (ins.samples.length === 0) {
          // An instrument with nothing in it may be left out; if kept it stays empty.
          expect(t?.samples.length ?? 0).toBe(0);
          return;
        }
        expect(t, `instrument ${i + 1}`).toBeDefined();
        expect(t!.name).toBe(ins.name);
        expect(t!.samples.length).toBe(ins.samples.length);
        expect(t!.keymap).toEqual(ins.keymap);
        expect(t!.volumeEnvelope).toEqual(ins.volumeEnvelope);
        expect(t!.panningEnvelope).toEqual(ins.panningEnvelope);
        expect(t!.volumeFadeout).toBe(ins.volumeFadeout);
        expect([t!.vibratoType, t!.vibratoSweep, t!.vibratoDepth, t!.vibratoRate]).toEqual([ins.vibratoType, ins.vibratoSweep, ins.vibratoDepth, ins.vibratoRate]);
        ins.samples.forEach((s, j) => {
          const u = t!.samples[j]!;
          expect([u.name, u.bits, u.volume, u.finetune, u.panning, u.relativeNote]).toEqual([s.name, s.bits, s.volume, s.finetune, s.panning, s.relativeNote]);
          expect(Buffer.from(u.data.buffer).equals(Buffer.from(s.data.buffer)), `instrument ${i + 1} sample ${j + 1} data`).toBe(true);
          expect(u.loopType).toBe(s.loopType);
          if (s.loopType !== 'none' && s.data.length > 0) expect([u.loopStart, u.loopLength]).toEqual([s.loopStart, s.loopLength]);
        });
      });
    }, 60000);
  }

  it('lists only FastTracker 2 songs for .xm', () => {
    const song = importXmToTrackerSong(load('christms.xm').slice().buffer);
    expect(describeSongExporter(xmExporter, song).state).toBe('enabled');
    song.data.moduleFormat = 'protracker';
    expect(describeSongExporter(xmExporter, song).state).toBe('unavailable');
    expect(SONG_EXPORTERS).toContain(xmExporter);
  });

  it('exports a new module as a valid empty .xm', () => {
    const xm = parseXm(xmExporter.serialize(createNewXmTrackerSong()));
    expect(xm.numChannels).toBe(8);
    expect(xm.songLength).toBe(1);
    expect(xm.patterns[0]!.numRows).toBe(64);
    expect(xm.linearFrequency).toBe(true);
    expect(xm.defaultSpeed).toBe(6);
    expect(xm.defaultBpm).toBe(125);
  });

  it('derives cells for rows authored here', () => {
    const song = createNewXmTrackerSong();
    song.data.patterns[0]!.tracks[0]!.entries.push(
      { row: 0, note: 'C-4', instrument: '01', volume: '80' },
      { row: 4, note: 'D-4', macro: 'A04' },
      { row: 8, note: '###' },
      { row: 12, note: 'E-4', macro: 'G20' },
      { row: 16, volumeCommand: '85' },
    );
    const rows = parseXm(xmExporter.serialize(song)).patterns[0]!.rows;
    // C-4 is XM note 49.
    expect(rows[0]![0]).toEqual({ note: 49, instrument: 1, volumeColumn: 0x30, effectType: 0, effectParam: 0 });
    expect(rows[4]![0]).toEqual({ note: 51, instrument: 0, volumeColumn: 0, effectType: 0xa, effectParam: 4 });
    expect(rows[8]![0]).toMatchObject({ note: 97 });
    expect(rows[12]![0]).toEqual({ note: 53, instrument: 0, volumeColumn: 0, effectType: 0x10, effectParam: 0x20 });
    expect(rows[16]![0]).toMatchObject({ volumeColumn: 0x85 });
  });
});

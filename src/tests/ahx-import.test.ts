// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  looksLikeAhx,
  looksLikeMod,
  looksLikeXm,
  looksLikeS3m,
  parseAhx,
} from '@another-synth/tracker-playback';
import { TOTAL_SLOTS } from '@another-synth/tracker-playback';
import { importAhxToTrackerSong, looksLikeAhxModule } from 'src/audio/tracker/ahx-import';
import { ahxSourceOf } from 'src/audio/tracker/ahx-source';

const DEMOS = path.resolve(__dirname, '../../public/demos');

function bytes(file: string): Uint8Array {
  const buf = fs.readFileSync(path.join(DEMOS, file));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const manifest = JSON.parse(fs.readFileSync(path.join(DEMOS, 'index.json'), 'utf8')) as {
  collections: {
    id: string;
    songs: {
      file: string;
      title: string;
      format: string;
      channels: number;
      patterns: number;
      instruments: number;
      bytes: number;
    }[];
  }[];
};
const ahxFiles = fs
  .readdirSync(path.join(DEMOS, 'ahx'))
  .filter((f) => /\.(ahx|hvl)$/i.test(f))
  .sort();

describe('AHX/HVL demo manifest', () => {
  const entries = manifest.collections.find((c) => c.id === 'ahx')?.songs ?? [];

  it('lists every .ahx/.hvl file on disk, and nothing else', () => {
    expect(entries.map((e) => e.file).sort()).toEqual(ahxFiles.map((f) => `ahx/${f}`));
    expect(ahxFiles.length).toBeGreaterThanOrEqual(24);
  });

  it.each(ahxFiles)('%s: the manifest header parse agrees with parseAhx', (file) => {
    const entry = entries.find((e) => e.file === `ahx/${file}`)!;
    const raw = bytes(`ahx/${file}`);
    const song = parseAhx(raw);
    expect(entry.format).toBe(song.format.toUpperCase());
    expect(entry.title).toBe(song.name.trim() || path.basename(file, path.extname(file)));
    expect(entry.channels).toBe(song.channels);
    expect(entry.patterns).toBe(song.positionNr);
    expect(entry.instruments).toBe(song.instrumentNr);
    expect(entry.bytes).toBe(raw.length);
  });
});

describe('format detection keeps AHX and the sampled formats apart', () => {
  it.each(ahxFiles)('%s is AHX/HVL and not MOD, XM or S3M', (file) => {
    const raw = bytes(`ahx/${file}`);
    expect(looksLikeAhxModule(raw)).toBe(true);
    // parseSongBuffer tests these first, so a heuristic MOD hit would win.
    expect(looksLikeMod(raw)).toBe(false);
    expect(looksLikeXm(raw)).toBe(false);
    expect(looksLikeS3m(raw)).toBe(false);
  });

  it('no MOD/XM/S3M demo is mistaken for AHX', () => {
    for (const dir of ['amiga', 'ft2', 's3m']) {
      for (const file of fs.readdirSync(path.join(DEMOS, dir))) {
        expect(looksLikeAhx(bytes(`${dir}/${file}`)), `${dir}/${file}`).toBe(false);
      }
    }
  });
});

describe('importAhxToTrackerSong', () => {
  const raw = bytes('ahx/karma.ahx');
  const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  const songFile = importAhxToTrackerSong(buffer);
  const song = parseAhx(raw);

  it('tags the song ahx and carries the title', () => {
    expect(songFile.data.moduleFormat).toBe('ahx');
    expect(songFile.data.currentSong.title).toBe('Karma');
    // Titles are stored space-padded in some files; the editor shows them trimmed.
    expect(songFile.data.currentSong.title).toBe(songFile.data.currentSong.title.trim());
  });

  it('builds one pattern per position, played in order', () => {
    expect(songFile.data.patterns).toHaveLength(song.positionNr);
    expect(songFile.data.sequence).toEqual(songFile.data.patterns.map((p) => p.id));
    expect(songFile.data.currentPatternId).toBe(songFile.data.patterns[0]!.id);
    expect(songFile.data.patternRows).toBe(song.trackLength);
  });

  // Task 5 B1 changed this: it used to pin `instrumentSlots: []` (AHX songs
  // listed no instruments). Morten approved listing them, so an AHX song now
  // has one name-only slot per file instrument -- still no patch, still no
  // sampler: the worklet plays the file, and the slot only lists the
  // instrument and keeps its parsed data (`ahxData`) for the display editor.
  it('lists each AHX instrument as a name-only ahx/ahx slot with no patch', () => {
    const filled = songFile.data.instrumentSlots.filter((s) => s.instrumentType);
    expect(filled).toHaveLength(song.instrumentNr);
    for (const slot of filled) {
      const instrument = song.instruments[slot.slot]!;
      expect(slot.instrumentType).toBe('ahx');
      expect(slot.instrumentFormat).toBe('ahx');
      expect(slot.patchId).toBeUndefined();
      expect(slot.oplData).toBeUndefined();
      expect(slot.instrumentName).toBe(instrument.name.trim() || slot.instrumentName);
      expect(slot.instrumentName).not.toBe('');
      expect(slot.ahxData).toEqual(instrument);
    }
    // Slots are addressed by the file's own instrument number, the number the
    // row model prints, and every other slot stays empty and untagged.
    expect(filled.map((s) => s.slot)).toEqual(
      Array.from({ length: song.instrumentNr }, (_, i) => i + 1),
    );
    expect(songFile.data.instrumentSlots).toHaveLength(TOTAL_SLOTS);
    expect(songFile.data.songPatches).toEqual({});
  });

  it('leaves HVL songs without instrument slots (they need their own format tag)', () => {
    const hvl = bytes('ahx/doobrey_gubbins.hvl');
    const file = importAhxToTrackerSong(
      hvl.buffer.slice(hvl.byteOffset, hvl.byteOffset + hvl.byteLength) as ArrayBuffer,
    );
    expect(file.data.instrumentSlots).toEqual([]);
    expect(file.data.songPatches).toEqual({});
  });

  it('keeps the file bytes alongside, keyed by the song file', () => {
    expect(ahxSourceOf(songFile)).not.toBeNull();
    expect(Array.from(ahxSourceOf(songFile)!)).toEqual(Array.from(raw));
    // A different song file has none.
    expect(ahxSourceOf(importAhxToTrackerSong(buffer))).not.toBe(ahxSourceOf(songFile));
  });

  it('gives an HVL its native channel count as tracks', () => {
    const hvl = bytes('ahx/doobrey_gubbins.hvl');
    const file = importAhxToTrackerSong(
      hvl.buffer.slice(hvl.byteOffset, hvl.byteOffset + hvl.byteLength) as ArrayBuffer,
    );
    expect(file.data.patterns[0]!.tracks).toHaveLength(11);
  });

  // plan-hvl-header-ux-0923.md BUG 1: the format carries a per-channel
  // position transpose (`formats/ahx.ts`'s parse, the engine's per-step
  // `v.transpose`), the row model drops it, and the read-only header chip
  // needs it — so the import keeps it beside the rows, one entry per channel.
  it('keeps each position transpose per channel on the pattern (AHX and HVL)', () => {
    for (const file of ['ahx/karma.ahx', 'ahx/doobrey_gubbins.hvl']) {
      const raw = bytes(file);
      const imported = importAhxToTrackerSong(
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
      );
      const song = parseAhx(raw);
      imported.data.patterns.forEach((pattern, index) => {
        expect(pattern.positionTranspose, `${file} position ${index}`).toEqual(
          song.positions[index]!.transpose,
        );
      });
    }
  });

  it('copies the transpose bytes, so the import cannot alias the parse', () => {
    const imported = importAhxToTrackerSong(buffer);
    imported.data.patterns[0]!.positionTranspose![0] = 99;
    expect(song.positions[0]!.transpose[0]).not.toBe(99);
  });

  it('rejects a file that is not AHX/HVL rather than producing a silent song', () => {
    const bad = raw.slice();
    bad[0] = 0x58; // 'X' for 'T': no longer a THX header
    expect(() =>
      importAhxToTrackerSong(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength) as ArrayBuffer),
    ).toThrow();
  });
});

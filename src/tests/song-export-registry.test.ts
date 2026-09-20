import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TrackerSongFile } from 'src/stores/tracker-store';
import { importAhxToTrackerSong } from 'src/audio/tracker/ahx-import';
import {
  ahxExporter,
  describeSongExporter,
  downloadBytes,
  exportFileName,
  getSongExporter,
  hvlExporter,
  SONG_EXPORTERS,
  SongExportError,
} from 'src/audio/tracker/song-export';

const DEMOS = resolve(__dirname, '../../public/demos/ahx');
const demo = (name: string): ArrayBuffer => {
  const b = readFileSync(resolve(DEMOS, name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

const ahxSong = (): TrackerSongFile => importAhxToTrackerSong(demo('karma.ahx'));
/** A different object with the same data: it carries no source record (`ahx-source` keys on identity). */
const withoutSource = (song: TrackerSongFile): TrackerSongFile => ({ ...song, data: { ...song.data } });

describe('the exporter registry', () => {
  it('lists ahx, hvl, mod, xm, s3m in that order with unique ids', () => {
    expect(SONG_EXPORTERS.map((e) => e.id)).toEqual(['ahx', 'hvl', 'mod', 'xm', 's3m']);
    expect(new Set(SONG_EXPORTERS.map((e) => e.id)).size).toBe(SONG_EXPORTERS.length);
  });

  it('has a writer for ahx and hvl only', () => {
    expect(SONG_EXPORTERS.map((e) => [e.id, e.available])).toEqual([
      ['ahx', true],
      ['hvl', true],
      ['mod', false],
      ['xm', false],
      ['s3m', false],
    ]);
    expect(getSongExporter('ahx')).toBe(ahxExporter);
    expect(getSongExporter('hvl')).toBe(hvlExporter);
    expect(getSongExporter('xm')?.extension).toBe('.xm');
  });

  it('gives every row a label, a dotted extension and a mime type; only rows with a writer have a description', () => {
    for (const e of SONG_EXPORTERS) {
      expect(e.label.length, e.id).toBeGreaterThan(0);
      expect(e.extension, e.id).toBe(`.${e.id}`);
      expect(e.mimeType, e.id).toBe('application/octet-stream');
      expect(e.description.length > 0, e.id).toBe(e.available);
    }
    expect(getSongExporter('hvl')?.label).toBe('HVL (Hively Tracker)');
  });

  it('pins the row descriptions: one short plain sentence, nothing about Author, BPM or the format', () => {
    expect(ahxExporter.description).toBe('Saves the song as an .ahx file, with your instrument and title changes.');
    expect(hvlExporter.description).toBe('Saves the song as an .hvl file, with your title change.');
    for (const e of SONG_EXPORTERS) expect(e.description, e.id).not.toMatch(/author|bpm|speed multiplier|tempo|no place/i);
  });

  it('states every row for every kind of song', () => {
    const native: TrackerSongFile = { ...withoutSource(ahxSong()), data: { ...ahxSong().data, moduleFormat: 'native' } };
    const xm: TrackerSongFile = { ...withoutSource(ahxSong()), data: { ...ahxSong().data, moduleFormat: 'xm' } };
    const rows = (song: TrackerSongFile) =>
      Object.fromEntries(SONG_EXPORTERS.map((e) => [e.id, describeSongExporter(e, song)]));
    const notYet = { state: 'not-implemented', reason: 'Not available yet.' };

    expect(rows(ahxSong())).toEqual({
      ahx: { state: 'enabled' },
      hvl: { state: 'unavailable', reason: "AHX songs can't be saved as HVL." },
      mod: notYet,
      xm: notYet,
      s3m: notYet,
    });
    expect(rows(importAhxToTrackerSong(demo('chiprolled.hvl')))).toEqual({
      ahx: { state: 'unavailable', reason: 'AHX files have 4 tracks; this song reaches track 6. Export it as HVL instead.' },
      hvl: { state: 'enabled' },
      mod: notYet,
      xm: notYet,
      s3m: notYet,
    });
    expect(rows(xm)).toMatchObject({
      ahx: { state: 'unavailable', reason: "XM songs can't be saved as AHX." },
      hvl: { state: 'unavailable', reason: "XM songs can't be saved as HVL." },
    });
    expect(rows(native)).toMatchObject({
      ahx: { state: 'unavailable', reason: "Songs made from scratch can't be exported yet." },
      hvl: { state: 'unavailable', reason: "Songs made from scratch can't be exported yet." },
    });
    expect(rows(withoutSource(ahxSong()))).toMatchObject({
      ahx: { state: 'unavailable', reason: 'This song has no original file to export from.' },
      hvl: { state: 'unavailable', reason: 'This song has no original file to export from.' },
    });
    expect(rows(withoutSource(importAhxToTrackerSong(demo('chiprolled.hvl'))))).toMatchObject({
      ahx: { state: 'unavailable', reason: 'This song has no original file to export from.' },
      hvl: { state: 'unavailable', reason: 'This song has no original file to export from.' },
    });
  });

  it('states the AHX row as enabled for an AHX song with its source', () => {
    expect(describeSongExporter(ahxExporter, ahxSong())).toEqual({ state: 'enabled' });
  });

  it('states the AHX row as unavailable for an XM song, a wide HVL song and an AHX song without source', () => {
    const xm: TrackerSongFile = { ...withoutSource(ahxSong()), data: { ...ahxSong().data, moduleFormat: 'xm' } };
    expect(describeSongExporter(ahxExporter, xm)).toEqual({
      state: 'unavailable',
      reason: "XM songs can't be saved as AHX.",
    });

    expect(describeSongExporter(ahxExporter, importAhxToTrackerSong(demo('chiprolled.hvl')))).toEqual({
      state: 'unavailable',
      reason: 'AHX files have 4 tracks; this song reaches track 6. Export it as HVL instead.',
    });

    expect(describeSongExporter(ahxExporter, withoutSource(ahxSong()))).toEqual({
      state: 'unavailable',
      reason: 'This song has no original file to export from.',
    });
  });

  it('states every placeholder as not implemented, whatever the song, without asking it to check', () => {
    for (const id of ['mod', 'xm', 's3m'] as const) {
      const exporter = getSongExporter(id)!;
      const check = vi.spyOn(exporter, 'check');
      expect(describeSongExporter(exporter, ahxSong()), id).toEqual({
        state: 'not-implemented',
        reason: 'Not available yet.',
      });
      expect(check).not.toHaveBeenCalled();
      check.mockRestore();
    }
  });

  it('makes a placeholder serialize throw a SongExportError', () => {
    for (const id of ['mod', 'xm', 's3m'] as const) {
      const exporter = getSongExporter(id)!;
      expect(() => exporter.serialize(ahxSong()), id).toThrow(SongExportError);
      expect(() => exporter.serialize(ahxSong()), id).toThrow(`${exporter.label} export isn't available yet.`);
    }
  });

  it('reports a check that throws as unavailable instead of throwing', () => {
    const broken = { ...ahxExporter, check: () => { throw new Error('boom'); } };
    expect(describeSongExporter(broken, ahxSong())).toEqual({
      state: 'unavailable',
      reason: "This song can't be checked for export: boom",
    });
  });
});

describe('exportFileName', () => {
  it.each([
    ['', 'song.ahx'],
    ['!!!', 'song.ahx'],
    ['___', 'song.ahx'],
    ['My Song', 'My_Song.ahx'],
    ['my-song_v2', 'my-song_v2.ahx'],
    ['a  b', 'a_b.ahx'],
    ['a__b', 'a_b.ahx'],
    ['../etc/passwd', 'etc_passwd.ahx'],
    ['C:\\temp\\x', 'C_temp_x.ahx'],
    ['song...', 'song.ahx'],
    ['  padded  ', 'padded.ahx'],
    ['Caf' + String.fromCharCode(233) + ' del Mar', 'Caf_del_Mar.ahx'],
    [String.fromCharCode(0x30c6, 0x30b9, 0x30c8), 'song.ahx'],
    ['a'.repeat(100), `${'a'.repeat(64)}.ahx`],
    [`${'x'.repeat(63)} y`, `${'x'.repeat(63)}.ahx`],
  ])('%j -> %s', (title, expected) => {
    expect(exportFileName(title, '.ahx')).toBe(expected);
  });

  it('puts the given extension on the end, whatever it is', () => {
    expect(exportFileName('T', '.xm')).toBe('T.xm');
    expect(exportFileName('', '.s3m')).toBe('song.s3m');
  });
});

describe('downloadBytes', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  it('clicks an attached a[download] on a Blob of the bytes, then removes it and revokes the URL later', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:song-export-test';
    });
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const seen: Array<{ download: string; href: string; attached: boolean }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      seen.push({ download: this.download, href: this.href, attached: document.body.contains(this) });
    });

    downloadBytes(new Uint8Array([1, 2, 3, 250]), 'My_Song.ahx', 'application/octet-stream');

    expect(seen).toEqual([{ download: 'My_Song.ahx', href: 'blob:song-export-test', attached: true }]);
    expect(document.querySelector('a[download]')).toBeNull();
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('application/octet-stream');
    expect(blobs[0]!.size).toBe(4);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:song-export-test');

    vi.useRealTimers();
    const content = await new Promise<number[]>((done) => {
      const reader = new FileReader();
      reader.onload = () => done(Array.from(new Uint8Array(reader.result as ArrayBuffer)));
      reader.readAsArrayBuffer(blobs[0]!);
    });
    expect(content).toEqual([1, 2, 3, 250]);
  });
});

/**
 * P5 -- S3M corpus pins on decode, not just parse.
 *
 * The corpus lives outside the repo (~/Downloads/mods/s3m, fetched from
 * modland.com/pub/modules/Screamtracker 3/ on 2026-09-03); the tests skip
 * when it is absent, like the XM corpus tests do. Selected by measured
 * property, not filename -- the category table in PLAN Phase 5:
 *
 *   satellite_one.s3m      PCM-only, 8 channels (classic Purple Motion)
 *   caverns_of_cthulu.s3m  PCM-only, exactly 4 channels
 *   o-79642.s3m            16-channel multi, PCM-only
 *   riverflow.s3m          32 enabled channels (the B2 voice-pressure ceiling)
 *   anguish.s3m            28 AdLib instruments declared (drives the warning)
 *   2nd_reality.s3m        5 AdLib instruments + PCM mix
 *   final_decade.s3m       amiga-limits flag set (flags & 0x10)
 *   return_to_saturn.s3m   amiga-limits flag set, 12 channels
 *   insanity_unnamed.s3m   10 sixteen-bit samples (signed LE, pack 0)
 *   turbulence.s3m         the s3m.txt "AMIGASLIDES" bit (0x04) an ST3.00 file
 *                          actually carries -- parsed, modelled by nothing
 *
 * The golden cells below were cross-checked against an independent reader
 * (the scan script used to select the corpus), not generated from the parser
 * under test. DP30AD1F-packed 16-bit samples: zero occurrences across the
 * 104-file sweep this corpus was drawn from -- see D101 for why that
 * category is recorded as absent rather than faked.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseS3m } from '../../packages/tracker-playback/src/formats/s3m';
import { importS3mToTrackerSong } from '../audio/tracker/s3m-import';

const CORPUS_DIR = path.join(os.homedir(), 'Downloads', 'mods', 's3m');
const hasCorpus = fs.existsSync(CORPUS_DIR);

/** Read a module as an exact ArrayBuffer (never a pooled view). */
function readModule(name: string): ArrayBuffer {
  const view = fs.readFileSync(path.join(CORPUS_DIR, name));
  return view.buffer.slice(
    view.byteOffset,
    view.byteOffset + view.byteLength,
  ) as ArrayBuffer;
}

function entryAt(
  song: ReturnType<typeof importS3mToTrackerSong>,
  patternIndex: number,
  trackIndex: number,
  row: number,
) {
  return song.data.patterns[patternIndex]!.tracks[trackIndex]!.entries.find(
    (e) => e.row === row,
  );
}

describe.skipIf(!hasCorpus)('S3M corpus: measured categories', () => {
  it('satellite_one.s3m: PCM-only 8-channel; golden cells on pattern 0', () => {
    const raw = new Uint8Array(readModule('satellite_one.s3m'));
    const s = parseS3m(raw);
    // Measured properties, not filename: every instrument is PCM, 8 enabled
    // channels, no AdLib anything.
    expect(s.instruments).toHaveLength(8);
    expect(s.instruments.every((i) => i.kind === 'pcm')).toBe(true);
    expect(
      s.channelSettings.filter((c) => c !== 0xff),
    ).toHaveLength(8);
    expect(s.instruments.some((i) => i.notDecoded)).toBe(false);

    const song = importS3mToTrackerSong(readModule('satellite_one.s3m'));
    expect(song.data.patterns[0]!.tracks).toHaveLength(8);
    // Golden cells, independently cross-checked: pattern 0, row 0.
    // Channel 0: file note 0x36 = F#4 (MIDI 66) on instrument 4.
    const ch0 = entryAt(song, 0, 0, 0)!;
    expect(ch0.note).toBe('F#4');
    expect(ch0.instrument).toBe('04');
    // Channel 2: note 0x36 with command 0x04 (Dxx volume slide) param 0x0A.
    const ch2 = entryAt(song, 0, 2, 0)!;
    expect(ch2.effectCommand).toBe(0x04);
    expect(ch2.effectParam).toBe(0x0a);
    expect(ch2.macro).toBe('D0A');
    // Channel 5: file note 0x44 = E5 (MIDI 76) with an explicit volume of 64.
    const ch5 = entryAt(song, 0, 5, 0)!;
    expect(ch5.note).toBe('E-5');
    expect(ch5.volume).toBe('FF');
  });

  it('caverns_of_cthulu.s3m: PCM-only, exactly 4 channels', () => {
    const s = parseS3m(new Uint8Array(readModule('caverns_of_cthulu.s3m')));
    expect(
      s.channelSettings.filter((c) => c !== 0xff),
    ).toHaveLength(4);
    expect(s.instruments.some((i) => i.kind === 'adlib')).toBe(false);
    const song = importS3mToTrackerSong(readModule('caverns_of_cthulu.s3m'));
    expect(song.data.patterns[0]!.tracks).toHaveLength(4);
  });

  it('o-79642.s3m: a 16-channel multi with no AdLib anywhere', () => {
    const s = parseS3m(new Uint8Array(readModule('o-79642.s3m')));
    expect(
      s.channelSettings.filter((c) => c !== 0xff),
    ).toHaveLength(16);
    expect(s.instruments.every((i) => i.kind === 'pcm')).toBe(true);
    const song = importS3mToTrackerSong(readModule('o-79642.s3m'));
    expect(song.data.patterns[0]!.tracks).toHaveLength(16);
  });

  it('riverflow.s3m: 32 enabled channels import 1:1 (the B2 ceiling case)', () => {
    const s = parseS3m(new Uint8Array(readModule('riverflow.s3m')));
    expect(
      s.channelSettings.filter((c) => c !== 0xff),
    ).toHaveLength(32);
    const song = importS3mToTrackerSong(readModule('riverflow.s3m'));
    expect(song.data.patterns[0]!.tracks).toHaveLength(32);
  });

  it('anguish.s3m + 2nd_reality.s3m: AdLib instruments are counted and warned, PCM intact', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anguish = importS3mToTrackerSong(readModule('anguish.s3m'));
    const second = importS3mToTrackerSong(readModule('2nd_reality.s3m'));
    const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
    warnSpy.mockRestore();

    const raw = parseS3m(new Uint8Array(readModule('anguish.s3m')));
    const adlibCount = raw.instruments.filter((i) => i.kind === 'adlib').length;
    expect(adlibCount).toBe(28);
    const warning = warnings.find((w) => w.includes('28 AdLib instruments ignored'));
    expect(warning).toBeDefined();

    // The rest of the module still imports: anguish keeps its 12 PCM slots
    // and its pattern-0 entries; 2nd_reality mixes 22 PCM + 5 AdLib.
    expect(
      anguish.data.instrumentSlots.filter((s) => s.patchId),
    ).toHaveLength(12);
    // OPL data lands on inactive slots wherever AdLib instruments are
    // actually referenced -- riverflow references two.
    const riverflow = importS3mToTrackerSong(readModule('riverflow.s3m'));
    expect(
      riverflow.data.instrumentSlots.filter((s) => s.oplData),
    ).toHaveLength(2);
    const secondRaw = parseS3m(new Uint8Array(readModule('2nd_reality.s3m')));
    expect(
      secondRaw.instruments.filter((i) => i.kind === 'pcm'),
    ).toHaveLength(22);
    expect(
      secondRaw.instruments.filter((i) => i.kind === 'adlib'),
    ).toHaveLength(5);
    expect(
      second.data.instrumentSlots.filter((s) => s.patchId).length,
    ).toBeGreaterThan(0);
  });

  it('final_decade.s3m / return_to_saturn.s3m: the amiga-limits flag rides to the song file', () => {
    for (const name of ['final_decade.s3m', 'return_to_saturn.s3m']) {
      const s = parseS3m(new Uint8Array(readModule(name)));
      expect(s.amigaLimits).toBe(true);
      const song = importS3mToTrackerSong(readModule(name));
      expect(song.data.amigaLimits).toBe(true);
    }
  });

  it('insanity_unnamed.s3m: 16-bit samples decode as signed LE with sane statistics', () => {
    const s = parseS3m(new Uint8Array(readModule('insanity_unnamed.s3m')));
    const pcm16 = s.instruments.filter((i) => i.bits16 && i.data.length > 0);
    expect(pcm16.length).toBeGreaterThanOrEqual(8);
    // A broken decode (wrong offset, wrong endianness, unsigned reading)
    // shows as a DC component near 0.5 and/or a flat-line roughness. Pin a
    // long sample (drum one-shots legitimately carry DC) to the -1..1
    // statistics of real audio: DC near zero, roughness in the audible band.
    const long = pcm16.reduce((a, b) => (b.data.length > a.data.length ? b : a));
    expect(long.data.length).toBeGreaterThan(100000);
    let sum = 0;
    let rough = 0;
    for (let i = 0; i < long.data.length; i++) {
      sum += long.data[i]!;
      rough += Math.abs(long.data[i]! - (long.data[i - 1] ?? 0));
    }
    const dc = sum / long.data.length;
    const roughness = rough / long.data.length;
    expect(Math.abs(dc)).toBeLessThan(0.02);
    expect(roughness).toBeGreaterThan(0.01);
    expect(roughness).toBeLessThan(0.5);
    // Loop bounds sane for every sample (the D73 loop-overflow lesson,
    // asserted rather than assumed).
    for (const instrument of s.instruments) {
      if (instrument.loopEnabled) {
        expect(instrument.loopEnd).toBeLessThanOrEqual(instrument.length);
      }
    }
  });

  it('turbulence.s3m: the s3m.txt AMIGASLIDES bit is parsed and changes nothing', () => {
    const s = parseS3m(new Uint8Array(readModule('turbulence.s3m')));
    // An ST3.00-written file actually carries flags & 0x04 -- the bit the
    // old spec calls AMIGASLIDES. Neither reference replayer implements it;
    // it must be recorded, never folded into behaviour.
    expect(s.amigaSlidesBitSet).toBe(true);
    expect(s.amigaLimits).toBe(false);
    const song = importS3mToTrackerSong(readModule('turbulence.s3m'));
    expect(song.data.amigaLimits).toBeUndefined();
  });
});

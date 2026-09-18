/**
 * P1 -- AHX/HVL parser (`formats/ahx.ts`), golden values against the real
 * corpus vendored at public/demos/ahx (`.ai/p0-report.md`).
 *
 * These pin the exact same fields the P0 Rust reference decoder
 * (`rust-wasm/src/ahx/format.rs`, `rust-wasm/tests/ahx_format.rs`) was
 * cross-checked against by hand -- the golden numbers here are copied from
 * that already-verified test suite, not re-derived, so a divergence between
 * the Rust and TS decoders on the same fixture bytes shows up as a failing
 * assertion in exactly one of the two suites.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { looksLikeAhx, parseAhx } from '@another-synth/tracker-playback';

const CORPUS_DIR = path.resolve(__dirname, '../../public/demos/ahx');

const HVL_FIXTURES = [
  'chiprolled.hvl',
  'doobrey_gubbins.hvl',
  'drainage_proble.hvl',
  'illuminated.hvl',
  'moderate_sellotaping.hvl',
  'sliding_away.hvl',
  'sunspots.hvl',
];

function readFixture(name: string): Uint8Array {
  const buf = fs.readFileSync(path.join(CORPUS_DIR, name));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

describe('looksLikeAhx', () => {
  it('sniffs every fixture in the corpus', () => {
    for (const name of ['karma.ahx', ...HVL_FIXTURES]) {
      expect(looksLikeAhx(readFixture(name)), name).toBe(true);
    }
  });

  it('rejects non-AHX bytes', () => {
    expect(looksLikeAhx(new TextEncoder().encode('not an ahx file'))).toBe(false);
    expect(looksLikeAhx(new Uint8Array(0))).toBe(false);
  });
});

describe('parseAhx: karma.ahx', () => {
  const song = parseAhx(readFixture('karma.ahx'));

  it('decodes the header', () => {
    expect(song.format).toBe('ahx');
    expect(song.version).toBe(1);
    expect(song.name).toBe('Karma');
    expect(song.channels).toBe(4);
    expect(song.positionNr).toBe(38);
    expect(song.restart).toBe(0);
    expect(song.speedMultiplier).toBe(1);
    expect(song.trackLength).toBe(64);
    expect(song.trackNr).toBe(74);
    expect(song.instrumentNr).toBe(31);
    expect(song.subsongNr).toBe(0);
    expect(song.subsongs).toEqual([]);
    expect(song.mixgainRaw).toBeUndefined();
    expect(song.defstereo).toBeUndefined();

    // Index 0 reserved, matching ht_Tracks[0..=trkn] / ht_Instruments[0..=insn].
    expect(song.positions.length).toBe(38);
    expect(song.tracks.length).toBe(75);
    expect(song.instruments.length).toBe(32);
  });

  it('decodes the first position', () => {
    const pos0 = song.positions[0]!;
    expect(pos0.track).toEqual([12, 13, 23, 56]);
    expect(pos0.transpose).toEqual([0, 0, 0, 0]);
  });

  it('decodes instrument 1', () => {
    const ins = song.instruments[1]!;
    expect(ins.name).toBe('#Oxide/Sonik');
    expect(ins.volume).toBe(38);
    expect(ins.waveLength).toBe(3);
    expect(ins.filterSpeed).toBe(0);
    expect(ins.envelope).toEqual({
      aFrames: 3,
      aVolume: 64,
      dFrames: 3,
      dVolume: 40,
      sFrames: 1,
      rFrames: 101,
      rVolume: 14,
    });
    expect(ins.filterLowerLimit).toBe(0);
    expect(ins.filterUpperLimit).toBe(0);
    expect(ins.vibratoDelay).toBe(17);
    expect(ins.vibratoSpeed).toBe(8);
    expect(ins.vibratoDepth).toBe(2);
    expect(ins.hardCutRelease).toBe(false);
    expect(ins.hardCutReleaseFrames).toBe(1);
    expect(ins.squareLowerLimit).toBe(4);
    expect(ins.squareUpperLimit).toBe(63);
    expect(ins.squareSpeed).toBe(2);

    expect(ins.plist.speed).toBe(3);
    expect(ins.plist.entries).toHaveLength(3);
    expect(ins.plist.entries[0]).toEqual({
      note: 1,
      waveform: 1,
      fixed: false,
      fx: [3, 4],
      fxParam: [63, 0],
    });
    expect(ins.plist.entries[1]).toEqual({
      note: 0,
      waveform: 0,
      fixed: false,
      fx: [0, 0],
      fxParam: [0, 0],
    });
    expect(ins.plist.entries[2]).toEqual({
      note: 0,
      waveform: 0,
      fixed: false,
      fx: [0, 0],
      fxParam: [0, 0],
    });
  });

  it('every real instrument carries a non-empty PList', () => {
    // Whole-file consistency check (hvl_load_ahx:148-152 walks every
    // instrument's PList length before any allocation happens), not just an
    // instrument-1 spot check -- mirrors the Rust corpus test.
    expect(song.instruments.length - 1).toBe(31);
    for (let i = 1; i < song.instruments.length; i++) {
      expect(song.instruments[i]!.plist.entries.length, `instrument ${i}`).toBeGreaterThan(0);
    }
  });

  it('degrades gracefully on a truncated file instead of throwing', () => {
    // Cut off partway through the position list: past the fixed header, so
    // the dimension fields still decode, but the name (whose offset points
    // into a trailing string table near the end of the file) and the
    // position/track/instrument reads run off the end.
    const truncated = readFixture('karma.ahx').slice(0, 100);
    const truncatedSong = parseAhx(truncated);
    expect(truncatedSong.name).toBe('');
    expect(truncatedSong.positionNr).toBe(38);
    // Bytes past offset 100 read as 0 rather than throwing.
    expect(truncatedSong.positions.at(-1)).toEqual({
      track: [0, 0, 0, 0],
      transpose: [0, 0, 0, 0],
    });
  });
});

describe('parseAhx: chiprolled.hvl', () => {
  const song = parseAhx(readFixture('chiprolled.hvl'));

  it('decodes the header', () => {
    expect(song.format).toBe('hvl');
    expect(song.version).toBe(0);
    expect(song.name).toBe('never gonna give you up');
    // HVL packs a channel count into the header and it is not always 4 --
    // this fixture alone contradicts the "AHX is always 4 channels" framing
    // for the HVL half of the format family. See .ai/p0-report.md.
    expect(song.channels).toBe(6);
    expect(song.positionNr).toBe(196);
    expect(song.restart).toBe(0);
    expect(song.speedMultiplier).toBe(2);
    expect(song.trackLength).toBe(16);
    expect(song.trackNr).toBe(84);
    expect(song.instrumentNr).toBe(11);
    expect(song.subsongNr).toBe(0);
    expect(song.mixgainRaw).toBe(86);
    expect(song.defstereo).toBe(2);

    const pos0 = song.positions[0]!;
    expect(pos0.track).toEqual([1, 3, 0, 0, 6, 45]);
    expect(pos0.transpose).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('decodes instrument 1', () => {
    const ins = song.instruments[1]!;
    expect(ins.name).toBe('i think i just');
    expect(ins.volume).toBe(64);
    expect(ins.waveLength).toBe(5);
    expect(ins.envelope).toEqual({
      aFrames: 1,
      aVolume: 64,
      dFrames: 1,
      dVolume: 64,
      sFrames: 1,
      rFrames: 12,
      rVolume: 0,
    });
    expect(ins.filterLowerLimit).toBe(1);
    expect(ins.filterUpperLimit).toBe(31);
    expect(ins.squareLowerLimit).toBe(32);
    expect(ins.squareUpperLimit).toBe(63);
    expect(ins.squareSpeed).toBe(3);

    expect(ins.plist.speed).toBe(1);
    expect(ins.plist.entries).toHaveLength(2);
    expect(ins.plist.entries[0]).toEqual({
      note: 1,
      waveform: 3,
      fixed: false,
      fx: [4, 0],
      fxParam: [0, 17],
    });
    expect(ins.plist.entries[1]).toEqual({
      note: 0,
      waveform: 0,
      fixed: false,
      fx: [3, 0],
      fxParam: [32, 0],
    });
  });
});

describe('parseAhx: .hvl corpus sweep', () => {
  it('decodes every fixture with a matching name, channel count and consistent structure', () => {
    const expected: Array<[string, string, number]> = [
      ['chiprolled.hvl', 'never gonna give you up', 6],
      ['doobrey_gubbins.hvl', 'doobrey gubbins', 11],
      ['drainage_proble.hvl', 'drainage problem', 7],
      ['illuminated.hvl', 'illuminated', 6],
      ['moderate_sellotaping.hvl', 'moderate sellotaping', 8],
      ['sliding_away.hvl', 'sliding away', 6],
      ['sunspots.hvl', 'sunspots', 6],
    ];

    for (const [file, name, channels] of expected) {
      const song = parseAhx(readFixture(file));
      expect(song.name, file).toBe(name);
      expect(song.channels, file).toBe(channels);
      expect(song.format, file).toBe('hvl');
      expect(song.positions.length, file).toBe(song.positionNr);
      expect(song.tracks.length, file).toBe(song.trackNr + 1);
      expect(song.instruments.length, file).toBe(song.instrumentNr + 1);
      for (const track of song.tracks) {
        expect(track.length, file).toBe(song.trackLength);
      }
    }
  });
});

describe('parseAhx: rejection', () => {
  it('rejects bad magic', () => {
    expect(() => parseAhx(new TextEncoder().encode('not an ahx file at all, 16+ bytes'))).toThrow();
  });

  it('rejects too-short buffers', () => {
    expect(() => parseAhx(new TextEncoder().encode('THX'))).toThrow();
    expect(() => parseAhx(new Uint8Array(0))).toThrow();
  });
});

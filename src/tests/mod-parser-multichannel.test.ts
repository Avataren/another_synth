import { describe, it, expect } from 'vitest';
import {
  looksLikeMod,
  parseMod,
  channelsForSignature,
  MAX_MOD_CHANNELS,
} from '../../packages/tracker-playback/src/mod-parser';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

const HEADER_SIZE = 1084;
const ROWS = 64;

interface CellSpec {
  row: number;
  channel: number;
  period?: number;
  sampleNumber?: number;
  effectCmd?: number;
  effectParam?: number;
}

/**
 * Build a single-pattern MOD with an arbitrary channel count and signature.
 */
function createModBuffer(
  signature: string,
  numChannels: number,
  cells: CellSpec[] = [],
): Uint8Array {
  const patternSize = ROWS * numChannels * 4;
  const sampleLengthWords = 4;
  const sampleLengthBytes = sampleLengthWords * 2;
  const buf = new Uint8Array(HEADER_SIZE + patternSize + sampleLengthBytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'MULTI', 20);

  let offset = 20;
  for (let i = 0; i < 31; i++) {
    writeAscii(buf, offset, i === 0 ? 'SAMPLE1' : '', 22);
    view.setUint16(offset + 22, i === 0 ? sampleLengthWords : 0, false);
    buf[offset + 24] = 0;
    buf[offset + 25] = 64;
    view.setUint16(offset + 26, 0, false);
    view.setUint16(offset + 28, 0, false);
    offset += 30;
  }

  buf[950] = 1; // song length
  buf[952] = 0; // order[0] -> pattern 0
  writeAscii(buf, 1080, signature, 4);

  for (const cell of cells) {
    const period = cell.period ?? 0;
    const sampleNumber = cell.sampleNumber ?? 0;
    const cellOffset =
      HEADER_SIZE + (cell.row * numChannels + cell.channel) * 4;
    buf[cellOffset] = (sampleNumber & 0xf0) | ((period >> 8) & 0x0f);
    buf[cellOffset + 1] = period & 0xff;
    buf[cellOffset + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd ?? 0);
    buf[cellOffset + 3] = cell.effectParam ?? 0;
  }

  return buf;
}

function writeAscii(buf: Uint8Array, offset: number, text: string, length: number) {
  for (let i = 0; i < length; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

describe('channelsForSignature', () => {
  it('maps the classic 4-channel tags', () => {
    for (const sig of ['M.K.', 'M!K!', 'M&K!', 'N.T.', 'FLT4', '4CHN']) {
      expect(channelsForSignature(sig)).toBe(4);
    }
  });

  it('maps single-digit <n>CHN tags', () => {
    expect(channelsForSignature('6CHN')).toBe(6);
    expect(channelsForSignature('8CHN')).toBe(8);
  });

  it('maps two-digit <nn>CH / <nn>CN tags', () => {
    expect(channelsForSignature('16CH')).toBe(16);
    expect(channelsForSignature('32CH')).toBe(32);
    expect(channelsForSignature('12CN')).toBe(12);
  });

  it('maps the fixed 8-channel and TakeTracker tags', () => {
    expect(channelsForSignature('OCTA')).toBe(8);
    expect(channelsForSignature('CD81')).toBe(8);
    expect(channelsForSignature('TDZ3')).toBe(3);
  });

  it('rejects unknown or out-of-range tags', () => {
    expect(channelsForSignature('ZZZZ')).toBeUndefined();
    expect(channelsForSignature('FLT8')).toBeUndefined();
    expect(channelsForSignature('99CH')).toBeUndefined();
    expect(channelsForSignature('')).toBeUndefined();
  });
});

describe('multi-channel MOD parsing', () => {
  it('parses a 6-channel module', () => {
    const buf = createModBuffer('6CHN', 6);
    expect(looksLikeMod(buf)).toBe(true);
    expect(parseMod(buf).numChannels).toBe(6);
  });

  it('parses an 8-channel module', () => {
    const buf = createModBuffer('8CHN', 8);
    expect(parseMod(buf).numChannels).toBe(8);
  });

  it('parses the maximum channel count', () => {
    const buf = createModBuffer('32CH', MAX_MOD_CHANNELS);
    expect(parseMod(buf).numChannels).toBe(MAX_MOD_CHANNELS);
  });

  it('reads cells from the correct channel at the correct stride', () => {
    // Channel indexing is the thing most at risk when the stride stops being
    // a hardcoded 4, so pin a distinct period per channel.
    const periods = [856, 808, 762, 720, 678, 640, 604, 570];
    const buf = createModBuffer(
      '8CHN',
      8,
      periods.map((period, channel) => ({
        row: 0,
        channel,
        period,
        sampleNumber: 1,
      })),
    );

    const mod = parseMod(buf);
    const row0 = mod.patterns[0]!.rows[0]!;
    expect(row0.map((c) => c.period)).toEqual(periods);
  });

  it('rejects Startrekker FLT8 explicitly rather than mis-decoding it', () => {
    const buf = createModBuffer('FLT8', 8);
    // Still recognised as a MOD, so the user gets the real reason.
    expect(looksLikeMod(buf)).toBe(true);
    expect(() => parseMod(buf)).toThrow(/FLT8/);
  });
});

describe('multi-channel MOD import', () => {
  it('creates one track per channel', () => {
    const buf = createModBuffer('8CHN', 8);
    const songFile = importModToTrackerSong(buf.buffer as ArrayBuffer);
    expect(songFile.data.patterns[0]!.tracks).toHaveLength(8);
  });

  it('keeps each channel effect on its own track', () => {
    // Effects are read per cell, so a stride bug would silently move an
    // effect to the wrong channel -- assert the mapping directly.
    // 1xx portamento up on ch0, 4xy vibrato on ch5, Cxx volume on ch7.
    const buf = createModBuffer('8CHN', 8, [
      { row: 0, channel: 0, period: 856, sampleNumber: 1, effectCmd: 0x1, effectParam: 0x04 },
      { row: 0, channel: 5, period: 856, sampleNumber: 1, effectCmd: 0x4, effectParam: 0x82 },
      { row: 0, channel: 7, period: 856, sampleNumber: 1, effectCmd: 0xc, effectParam: 0x20 },
    ]);

    const tracks = importModToTrackerSong(buf.buffer as ArrayBuffer).data.patterns[0]!.tracks;
    const row0 = (i: number) => tracks[i]!.entries.find((e) => e.row === 0);

    expect(row0(0)?.macro).toBe('104');
    expect(row0(5)?.macro).toBe('482');
    // Cxx moves to the volume column rather than staying a macro: 0x20/64 -> 0x80.
    expect(row0(7)?.macro).toBeUndefined();
    expect(row0(7)?.volume).toBe('80');
    // Channels with no effect must not inherit a neighbour's.
    expect(row0(1)?.macro).toBeUndefined();
    expect(row0(6)?.macro).toBeUndefined();
  });

  it('centres channels past the classic four', () => {
    // This previously asserted a repeating L-R-R-L grouping, which was an
    // assumption never checked against a real module. The Amiga layout comes
    // from Paula's four hardware voices being wired 2 left / 2 right; a
    // PC-tracker extension has no such wiring, and modules written for one
    // expect centred channels and place anything they care about with 8xx.
    // DOPE.MOD is 28 channels with 54 panning commands in total, so repeating
    // the grouping split it into two hard-panned halves.
    const buf = createModBuffer(
      '8CHN',
      8,
      Array.from({ length: 8 }, (_, channel) => ({
        row: 0,
        channel,
        period: 856,
        sampleNumber: 1,
      })),
    );

    const tracks = importModToTrackerSong(buf.buffer as ArrayBuffer).data.patterns[0]!.tracks;
    const pans = tracks.map((t) => t.entries.find((e) => e.row === 0)?.macro2);

    // M80 = centre.
    expect(pans).toEqual(new Array(8).fill('M80'));
  });

  it('leaves 4-channel panning exactly as before', () => {
    const buf = createModBuffer(
      'M.K.',
      4,
      Array.from({ length: 4 }, (_, channel) => ({
        row: 0,
        channel,
        period: 856,
        sampleNumber: 1,
      })),
    );

    const tracks = importModToTrackerSong(buf.buffer as ArrayBuffer).data.patterns[0]!.tracks;
    const pans = tracks.map((t) => t.entries.find((e) => e.row === 0)?.macro2);
    expect(pans).toEqual(['M40', 'MBF', 'MBF', 'M40']);
  });
});

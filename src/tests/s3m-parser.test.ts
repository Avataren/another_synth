/**
 * P5 -- S3M parser (`formats/s3m.ts`), synthetic modules.
 *
 * The S3M packing is nothing like XM's: rows are terminated by an explicit
 * zero byte and each flag byte names ONE channel plus the fields that follow
 * it. These tests pin the header layout, that packing, the note/volume byte
 * conventions verified against OpenMPT's Load_s3m.cpp (0xFE = note off,
 * 0xFF = "no note"; volume 0..64, 0xFF = none, 128..192 = panning), the
 * settled header-flag table (module comment in s3m.ts, quoted from
 * OpenMPT S3MTools.h + st3play dig.c), and the sample decoders.
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeS3m,
  parseS3m,
  S3M_KEY_OFF,
  S3M_NO_NOTE,
} from '../../packages/tracker-playback/src/formats/s3m';
import { buildS3m, type S3mSpec } from './helpers/s3m-builder';

function build(spec: S3mSpec) {
  const built = buildS3m(spec);
  return built;
}

describe('S3M header', () => {
  it('recognizes its own synthetic file', () => {
    const { bytes } = build({
      title: 'Header test',
      orders: [0, 1, 0],
      patterns: [[[]]],
      instruments: [],
    });
    expect(looksLikeS3m(bytes)).toBe(true);
  });

  it('rejects a file whose signature or type byte is wrong', () => {
    const { bytes } = build({ orders: [0], patterns: [[]] });
    bytes[0x2c] = 'X'.charCodeAt(0);
    expect(looksLikeS3m(bytes)).toBe(false);
    const { bytes: bytes2 } = build({ orders: [0], patterns: [[]] });
    bytes2[0x1d] = 0x11;
    expect(looksLikeS3m(bytes2)).toBe(false);
  });

  it('rejects a truncated buffer', () => {
    expect(looksLikeS3m(new Uint8Array(16))).toBe(false);
  });

  it('throws a real error on a non-S3M buffer', () => {
    expect(() => parseS3m(new Uint8Array(64))).toThrow(/S3M/);
  });

  it('round-trips title, version word and speeds', () => {
    const { bytes } = build({
      title: 'Round trip',
      cwtv: 0x1320,
      formatVersion: 2,
      globalVolume: 48,
      speed: 5,
      tempo: 140,
      masterVolume: 0xc0,
      orders: [0],
      patterns: [[[]]],
    });
    const s = parseS3m(bytes);
    expect(s.title).toBe('Round trip');
    expect(s.trackerVersion).toBe(0x1320);
    expect(s.formatVersion).toBe(2);
    expect(s.globalVolume).toBe(48);
    expect(s.initialSpeed).toBe(5);
    expect(s.initialTempo).toBe(140);
    expect(s.masterStereo).toBe(true);
    expect(s.songLength).toBe(1);
    expect(s.orders).toEqual([0]);
  });

  it('decodes the settled header-flag table', () => {
    // 0x01 st2vibrato + 0x10 amigaLimits + 0x40 fastVolumeSlides, plus the
    // replayer-orphaned 0x04 "AMIGASLIDES" bit.
    const { bytes } = build({ flags: 0x55, orders: [0], patterns: [[]] });
    const s = parseS3m(bytes);
    expect(s.st2Vibrato).toBe(true);
    expect(s.amigaLimits).toBe(true);
    expect(s.fastVolumeSlides).toBe(true);
    expect(s.amigaSlidesBitSet).toBe(true);
    expect(s.flags).toBe(0x55);
  });

  it('records custom data from the special field, not a flags bit', () => {
    const withSpecial = parseS3m(build({ special: 0x1234, orders: [0], patterns: [[]] }).bytes);
    expect(withSpecial.hasCustomData).toBe(true);
    const without = parseS3m(build({ orders: [0], patterns: [[]] }).bytes);
    expect(without.hasCustomData).toBe(false);
  });

  it('reads channel settings and the panning table untouched', () => {
    const settings = [0x00, 0x08, 0x10, 0x12, 0x20, 0xff];
    const pans = Array.from({ length: 32 }, (_, i) => (i < 4 ? 0x28 : 0x08));
    const { bytes } = build({
      channelSettings: settings,
      panningTable: pans,
      orders: [0],
      patterns: [[]],
    });
    const s = parseS3m(bytes);
    for (let ch = 0; ch < 6; ch++) {
      expect(s.channelSettings[ch]).toBe(settings[ch]!);
    }
    // Unset channels read 0xFF (disabled), never garbage.
    expect(s.channelSettings[31]).toBe(0xff);
    expect(s.hasPanningTable).toBe(true);
    expect(s.defaultPans).toEqual(pans);
  });

  it('keeps order-table 254/255 bytes untouched (importer policy)', () => {
    const { bytes } = build({ orders: [0, 254, 255, 3], patterns: [[]] });
    const s = parseS3m(bytes);
    expect(s.orders).toEqual([0, 254, 255, 3]);
    expect(s.songLength).toBe(4);
  });
});

describe('S3M pattern decoding', () => {
  it('decodes note/instrument, volume and effect fields per cell', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [
        [
          [
            { note: 0x30, instrument: 2, volume: 40, effect: 0x01, param: 0x03 },
            undefined,
          ],
          [{ effect: 0x04, param: 0xc0 }],
        ],
      ],
    });
    const s = parseS3m(bytes);
    const rows = s.patterns[0]!.rows;
    expect(rows).toHaveLength(64);
    expect(rows[0]![0]).toMatchObject({
      note: 0x30,
      instrument: 2,
      volume: 40,
      effectCommand: 0x01,
      effectParam: 0x03,
    });
    // A channel not mentioned in a row is simply empty -- no carry-over.
    expect(rows[0]![1]).toMatchObject({ instrument: 0, effectCommand: 0 });
    // Channel 0, row 1: command only, no note field at all.
    expect(rows[1]![0]).toMatchObject({
      effectCommand: 0x04,
      effectParam: 0xc0,
    });
    expect(rows[1]![0]!.note).toBeUndefined();
  });

  it('preserves the note-byte conventions: 0xFE key-off, 0xFF instrument-only', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [
        [
          [{ note: S3M_KEY_OFF, instrument: 1 }, { note: S3M_NO_NOTE, instrument: 3 }],
        ],
      ],
    });
    const s = parseS3m(bytes);
    expect(s.patterns[0]!.rows[0]![0]!.note).toBe(0xfe);
    expect(s.patterns[0]!.rows[0]![1]!.note).toBe(0xff);
    expect(s.patterns[0]!.rows[0]![1]!.instrument).toBe(3);
  });

  it('a truncated pattern yields predictable empty rows', () => {
    const { bytes } = build({ orders: [0], patterns: [[[
      { note: 0x00, instrument: 1 },
    ]]] });
    // Hand-truncate the buffer in the middle of the first cell: the decoder
    // must fill the rest with empty cells, never throw or read garbage.
    // Pattern parapointer: order table (1 byte @ 0x60), no samples, so the
    // first pattern pointer is the u16 at 0x61.
    const patternPointer = bytes[0x61]! | (bytes[0x62]! << 8);
    const at = patternPointer * 16;
    const truncated = bytes.subarray(0, at + 4); // size + 2 bytes of one cell
    const s = parseS3m(truncated);
    expect(s.patterns).toHaveLength(1);
    expect(s.patterns[0]!.rows).toHaveLength(64);
    // Row 0's cell got its flag byte and a partial field at most; every cell
    // of every later row is empty.
    for (let row = 1; row < 64; row++) {
      for (const cell of s.patterns[0]!.rows[row]!) {
        expect(cell.note).toBeUndefined();
        expect(cell.instrument).toBe(0);
        expect(cell.effectCommand).toBe(0);
      }
    }
  });
});

describe('S3M instrument headers and sample decode', () => {
  it('round-trips a PCM sample header', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [
        {
          name: 'Piano',
          frames: [0, 0.5, -0.5, 0],
          volume: 52,
          c2spd: 16726,
          loop: true,
          loopStart: 1,
          loopEnd: 3,
        },
      ],
    });
    const s = parseS3m(bytes);
    const ins = s.instruments[0]!;
    expect(ins.kind).toBe('pcm');
    expect(ins.name).toBe('Piano');
    expect(ins.volume).toBe(52);
    expect(ins.c2spd).toBe(16726);
    expect(ins.length).toBe(4);
    expect(ins.loopEnabled).toBe(true);
    expect(ins.loopStart).toBe(1);
    expect(ins.loopEnd).toBe(3);
  });

  it('decodes unsigned 8-bit samples centred on 128', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames: [0, 0.5, -1, 0] }],
    });
    const s = parseS3m(bytes);
    const data = s.instruments[0]!.data;
    expect(data).toHaveLength(4);
    expect(data[0]).toBeCloseTo(0.0, 5); // 128 -> 0.0
    expect(data[1]).toBeCloseTo(0.5, 5); // 192 -> +0.5
    expect(data[2]).toBeCloseTo(-1.0, 5); // 0 -> -1.0
  });

  it('decodes signed 8-bit samples in old-version (format version 1) files', () => {
    const frames = [-128, -64, 64, 127];
    const { bytes } = build({
      formatVersion: 1,
      orders: [0],
      patterns: [[]],
      instruments: [{ frames }],
    });
    // Overwrite the data bytes with the signed values an old file would
    // carry; the data position comes from the header's own memseg bytes
    // (OpenMPT's GetSampleOffset packing).
    const pointer = bytes[0x61]! | (bytes[0x62]! << 8);
    const header = pointer * 16;
    const dataOffset =
      ((bytes[header + 14] ?? 0) << 4) |
      ((bytes[header + 15] ?? 0) << 12) |
      ((bytes[header + 13] ?? 0) << 20);
    for (let i = 0; i < frames.length; i++) {
      bytes[dataOffset + i] = frames[i]! & 0xff;
    }
    const s = parseS3m(bytes);
    const data = s.instruments[0]!.data;
    expect(data[0]).toBeCloseTo(-1.0, 5);
    expect(data[1]).toBeCloseTo(-0.5, 5);
    expect(data[2]).toBeCloseTo(0.5, 5);
    expect(data[3]).toBeCloseTo(127 / 128, 5);
  });

  it('decodes 16-bit samples as signed little-endian', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames16: [0, 16384, -16384, -1] }],
    });
    const s = parseS3m(bytes);
    const ins = s.instruments[0]!;
    expect(ins.bits16).toBe(true);
    const data = ins.data;
    expect(data).toHaveLength(4);
    expect(data[1]).toBeCloseTo(0.5, 5);
    expect(data[2]).toBeCloseTo(-0.5, 5);
    expect(data[3]).toBeCloseTo(-1 / 32768, 6);
  });

  it('skips stereo samples with a reason, never decodes half of one', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames: [0, 0.5, -0.5, 0], stereo: true }],
    });
    const s = parseS3m(bytes);
    const ins = s.instruments[0]!;
    expect(ins.stereo).toBe(true);
    expect(ins.data).toHaveLength(0);
    expect(ins.notDecoded).toBe('stereo');
  });

  it('detects DP30AD1F packing and refuses to guess a decode', () => {
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames: [0, 0.5, -0.5, 0], packed: true }],
    });
    const s = parseS3m(bytes);
    const ins = s.instruments[0]!;
    expect(ins.packed).toBe(true);
    expect(ins.data).toHaveLength(0);
    expect(ins.notDecoded).toBe('dp30ad1f-packed');
  });

  it('parses AdLib instrument headers and keeps the OPL register bytes', () => {
    const registers = [0x20, 0x11, 0x16, 0x00, 0xf1, 0x05, 0xf3, 0x08, 0x00, 0x06, 0xc0, 0x00];
    const { bytes } = build({
      orders: [0],
      patterns: [[]],
      instruments: [
        { name: 'Brass', registers, volume: 45, c2spd: 9000, type: 2 },
        { name: 'Bass drum', registers: registers.slice(), volume: 60, type: 4 },
      ],
    });
    const s = parseS3m(bytes);
    const [melody, drum] = s.instruments;
    expect(melody!.kind).toBe('adlib');
    expect(melody!.adlibKind).toBe('melody');
    expect(melody!.name).toBe('Brass');
    expect(melody!.oplRegisters).toEqual(registers);
    expect(melody!.adlibVolume).toBe(45);
    expect(drum!.adlibKind).toBe('drum');
    expect(drum!.data).toHaveLength(0);
  });
});

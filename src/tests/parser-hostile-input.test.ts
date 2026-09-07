/**
 * P7 -- parser hardening against hostile headers (review 2026-09-07, H1/M1).
 *
 * The XM and S3M count fields are u16 and nothing in the format bounds them,
 * but every count is multiplied into allocation (XM: numRows x numChannels
 * cells per pattern; S3M: 64 x 32 cells per pattern) and the S3M
 * parapointer table is read with bare DataView calls. A crafted file must
 * degrade -- to a clamped, valid-shaped song or to the clean "Unsupported or
 * invalid ..." error -- instead of unbounded allocation or an uncaught
 * RangeError.
 */

import { describe, it, expect } from 'vitest';
import { parseXm, parseS3m } from '@another-synth/tracker-playback';
import { buildXm } from './helpers/xm-builder';
import { buildS3m } from './helpers/s3m-builder';

/** Minimal 9-byte XM pattern header: size 9, packing 0, rows, packedSize. */
function xmPatternHeader(numRows: number, packedSize = 0): number[] {
  return [
    9, 0, 0, 0, // pattern header size
    0, // packing type
    numRows & 0xff, (numRows >> 8) & 0xff,
    packedSize & 0xff, (packedSize >> 8) & 0xff,
  ];
}

/** Minimal 29-byte XM instrument header with no samples. */
function xmInstrumentHeader(): number[] {
  const bytes = new Array<number>(29).fill(0);
  bytes[0] = 29; // instrument header size (lo byte; the rest are 0)
  return bytes;
}

describe('XM hostile header counts (H1)', () => {
  it('clamps a 0xFFFF row count before allocating the pattern cells', () => {
    const bytes = buildXm({ numChannels: 32, orders: [0], patterns: [] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(70, 1, true); // numPatterns: one hostile pattern header
    // One minimal pattern header declaring 0xFFFF rows with no packed data.
    const header = xmPatternHeader(0xffff);
    const patched = new Uint8Array(bytes.length + header.length);
    patched.set(bytes, 0);
    patched.set(header, bytes.length);

    const song = parseXm(patched);
    expect(song.patterns.length).toBe(1);
    // Rows are clamped to the format's 256-row ceiling; the importer would
    // only have applied this clamp after the parser had already allocated
    // 65535 x 32 cells.
    expect(song.patterns[0]!.numRows).toBe(256);
    expect(song.patterns[0]!.rows.length).toBe(256);
    expect(song.patterns[0]!.rows[0]!.length).toBe(32);
  });

  it('clamps a 0xFFFF pattern count to the format ceiling', () => {
    const bytes = buildXm({ numChannels: 4, orders: [0], patterns: [] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(70, 0xffff, true); // numPatterns
    // 300 minimal one-row pattern headers follow the header.
    const extra: number[] = [];
    for (let i = 0; i < 300; i++) extra.push(...xmPatternHeader(1));
    const patched = new Uint8Array(bytes.length + extra.length);
    patched.set(bytes, 0);
    patched.set(extra, bytes.length);

    const song = parseXm(patched);
    expect(song.patterns.length).toBe(256);
  });

  it('clamps a 0xFFFF instrument count to the format ceiling', () => {
    const bytes = buildXm({ numChannels: 4, orders: [0], patterns: [] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(72, 0xffff, true); // numInstruments
    const extra: number[] = [];
    for (let i = 0; i < 300; i++) extra.push(...xmInstrumentHeader());
    const patched = new Uint8Array(bytes.length + extra.length);
    patched.set(bytes, 0);
    patched.set(extra, bytes.length);

    const song = parseXm(patched);
    expect(song.instruments.length).toBe(256);
  });

  it('clamps a 0xFFFF per-instrument sample count to the XM ceiling of 16', () => {
    const bytes = buildXm({
      numChannels: 4,
      orders: [0],
      patterns: [],
      instruments: [{ samples: [{ frames: [0, 100, -100] }] }],
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // With no patterns the first instrument header follows the order table.
    const instrAt = 60 + view.getUint32(60, true);
    view.setUint16(instrAt + 27, 0xffff, true); // numSamples
    // Room for far more sample headers than the ceiling, so the clamp (not
    // the buffer end) is what stops the loop.
    const patched = new Uint8Array(bytes.length + 2048);
    patched.set(bytes, 0);

    const song = parseXm(patched);
    expect(song.instruments.length).toBe(1);
    expect(song.instruments[0]!.samples.length).toBe(16);
    // The real sample header survives as sample 0.
    expect(song.instruments[0]!.samples[0]!.data.length).toBe(3);
  });

  it('stops at a pattern header too small to contain its own fields', () => {
    const bytes = buildXm({ numChannels: 4, orders: [0], patterns: [] });
    // headerSize 4: the rows/packedSize fields would be read out of the
    // header itself, so the offsets of every later pattern are garbage.
    const header = xmPatternHeader(64).map((v, i) => (i < 4 ? (i === 0 ? 4 : 0) : v));
    const patched = new Uint8Array(bytes.length + header.length);
    patched.set(bytes, 0);
    patched.set(header, bytes.length);

    const song = parseXm(patched);
    expect(song.patterns.length).toBe(0);
  });
});

describe('S3M hostile header counts (H1)', () => {
  it('fails with the clean error when the sample pointer table runs past the buffer', () => {
    const { bytes } = buildS3m({ orders: [0], patterns: [[]] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(0x22, 0xffff, true); // smpNum: table no longer fits
    // The old code hit a bare DataView read here: an uncaught RangeError
    // instead of the load path's own "unsupported module" error.
    expect(() => parseS3m(bytes)).toThrow(/S3M/);
  });

  it('fails with the clean error when the pattern pointer table runs past the buffer', () => {
    const { bytes } = buildS3m({ orders: [0], patterns: [[]] });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint16(0x24, 0xffff, true); // patNum
    expect(() => parseS3m(bytes)).toThrow(/S3M/);
  });

  it('clamps a 0xFFFF pattern count and decodes at most 256 patterns', () => {
    // Hand-built: header + one order + a 256-entry pattern pointer table all
    // inside the buffer, every entry aimed at one tiny packed pattern, and
    // patNum declaring 0xFFFF.
    const pointerBase = 0x60 + 1; // after the single order byte
    const patternAt = pointerBase + 256 * 2;
    // Paragraph-align the pattern data.
    const aligned = (patternAt + 15) & ~0xf;
    const bytes = new Uint8Array(aligned + 4);
    const view = new DataView(bytes.buffer);

    bytes[0x1c] = 0x1a; // DOS EOF marker
    bytes[0x1d] = 0x10; // fileType: ST3 module
    bytes.set([0x53, 0x43, 0x52, 0x4d], 0x2c); // 'SCRM'
    view.setUint16(0x20, 1, true); // ordNum
    view.setUint16(0x22, 0, true); // smpNum
    view.setUint16(0x24, 0xffff, true); // patNum: hostile
    bytes[0x60] = 0; // the one order: pattern 0

    const patternPara = Math.floor(aligned / 16);
    for (let i = 0; i < 256; i++) {
      view.setUint16(pointerBase + i * 2, patternPara, true);
    }
    // Packed pattern: size 2, then two end-of-row markers. Every remaining
    // row decodes as empty -- bounded by the clamp, 64 x 32 cells at most.
    view.setUint16(aligned, 2, true);
    bytes[aligned + 2] = 0;
    bytes[aligned + 3] = 0;

    const song = parseS3m(bytes);
    expect(song.patterns.length).toBe(256);
    expect(song.patterns[0]!.numRows).toBe(64);
    expect(song.patterns[0]!.rows.length).toBe(64);
    expect(song.patterns[0]!.rows[0]!.length).toBe(32);
  });

  it('clamps a 0xFFFF order count to a bounded sequence', () => {
    // Hand-built: header + a full 256-byte order region + one pattern pointer
    // + pattern data, with ordNum declaring 0xFFFF. The order bytes past the
    // written region would read as 255 padding forever, and the sequence
    // length feeds several O(n) import passes, so the clamp is what keeps a
    // crafted header from turning into a load-time CPU burn.
    const orderBase = 0x60;
    const pointerBase = orderBase + 256;
    const patternAt = (pointerBase + 2 + 15) & ~0xf; // paragraph-aligned
    const bytes = new Uint8Array(patternAt + 4);
    const view = new DataView(bytes.buffer);

    bytes[0x1c] = 0x1a; // DOS EOF marker
    bytes[0x1d] = 0x10; // fileType: ST3 module
    bytes.set([0x53, 0x43, 0x52, 0x4d], 0x2c); // 'SCRM'
    view.setUint16(0x20, 0xffff, true); // ordNum: hostile
    view.setUint16(0x22, 0, true); // smpNum
    view.setUint16(0x24, 1, true); // patNum
    bytes[orderBase] = 0; // the one real order: pattern 0

    view.setUint16(pointerBase, Math.floor(patternAt / 16), true);
    view.setUint16(patternAt, 2, true); // packed size
    bytes[patternAt + 2] = 0; // end of row 0
    bytes[patternAt + 3] = 0; // end of row 1

    const song = parseS3m(bytes);
    // Bounded, not just non-crashing: exactly the 256-order ceiling.
    expect(song.orders.length).toBe(256);
    expect(song.songLength).toBe(256);
    expect(song.orders[0]).toBe(0);
    expect(song.patterns.length).toBe(1);
  });
});

describe('S3M sample decode with a hostile memseg offset (M1)', () => {
  it('degrades to an empty sample when the offset points far past the buffer', () => {
    const { bytes } = buildS3m({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames: [128, 200, 30] }],
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const instrumentBase =
      view.getUint16(0x60 + 1, true) * 16; // first instrument parapointer
    // OpenMPT GetSampleOffset packing: (b1 << 4) | (b2 << 12) | (b0 << 20).
    // b0 = 0xFF puts the offset at ~267M -- past any real file.
    bytes[instrumentBase + 13] = 0xff;
    bytes[instrumentBase + 14] = 0;
    bytes[instrumentBase + 15] = 0;

    // The old code computed buffer.byteLength - offset as a large negative
    // number and fed it to `new Float32Array`, throwing a RangeError that
    // aborted the whole parse.
    const song = parseS3m(bytes);
    expect(song.instruments[0]!.kind).toBe('pcm');
    expect(song.instruments[0]!.data.length).toBe(0);
  });

  it('degrades to an empty sample for a hostile offset on a 16-bit sample', () => {
    const { bytes } = buildS3m({
      orders: [0],
      patterns: [[]],
      instruments: [{ frames16: [0, 1000, -1000], bits16: true }],
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const instrumentBase = view.getUint16(0x60 + 1, true) * 16;
    bytes[instrumentBase + 13] = 0xff;
    bytes[instrumentBase + 14] = 0;
    bytes[instrumentBase + 15] = 0;

    const song = parseS3m(bytes);
    expect(song.instruments[0]!.data.length).toBe(0);
  });
});
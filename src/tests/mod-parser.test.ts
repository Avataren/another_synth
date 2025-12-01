import { describe, it, expect } from 'vitest';
import {
  looksLikeMod,
  parseMod,
} from '../../packages/tracker-playback/src/mod-parser';

function createMinimalModBuffer(): Uint8Array {
  const NUM_CHANNELS = 4;
  const ROWS = 64;
  const HEADER_SIZE = 1084;
  const patternSize = ROWS * NUM_CHANNELS * 4;

  const sample1LengthWords = 4; // 8 bytes
  const sample1LengthBytes = sample1LengthWords * 2;
  const totalSize = HEADER_SIZE + patternSize + sample1LengthBytes;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // Title
  writeAscii(buf, 0, 'TEST MOD', 20);

  // Sample headers (31 samples, 30 bytes each)
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const isFirst = i === 0;

    const name = isFirst ? 'SAMPLE1' : '';
    writeAscii(buf, offset, name, 22);

    const lengthWords = isFirst ? sample1LengthWords : 0;
    view.setUint16(offset + 22, lengthWords, false); // big-endian

    // Finetune and volume
    buf[offset + 24] = 0; // finetune
    buf[offset + 25] = 64; // max volume

    // Loop points (disabled by default)
    view.setUint16(offset + 26, 0, false); // loop start
    view.setUint16(offset + 28, 0, false); // loop length

    offset += 30;
  }

  // Song length and restart position
  buf[950] = 1; // song length
  buf[951] = 0; // restart (unused)

  // Pattern order table
  buf[952] = 0; // first pattern index
  // others remain 0

  // Signature "M.K."
  writeAscii(buf, 1080, 'M.K.', 4);

  // Pattern data: one pattern, 64 rows * 4 channels * 4 bytes
  const patternDataOffset = HEADER_SIZE;

  // Put a single note in row 0, channel 0 using sample 1
  {
    const row = 0;
    const ch = 0;
    const cellOffset =
      patternDataOffset + (row * NUM_CHANNELS + ch) * 4;

    const period = 0x0358; // arbitrary legal period
    const sampleNumber = 1;

    // Encode sample number: high nibble in b0, low nibble in b2 (high nibble)
    const sampleHighNibble = (sampleNumber & 0xf0);
    const sampleLowNibble = (sampleNumber & 0x0f) << 4;

    const b0High = sampleHighNibble;
    const b0Low = (period >> 8) & 0x0f;

    const b0 = b0High | b0Low;
    const b1 = period & 0xff;
    const b2 = sampleLowNibble | 0x0; // effect cmd 0
    const b3 = 0x00; // effect param

    buf[cellOffset] = b0;
    buf[cellOffset + 1] = b1;
    buf[cellOffset + 2] = b2;
    buf[cellOffset + 3] = b3;
  }

  // Sample data for sample 1: 8 bytes of silence
  const sampleDataOffset = HEADER_SIZE + patternSize;
  for (let i = 0; i < sample1LengthBytes; i++) {
    buf[sampleDataOffset + i] = 0;
  }

  return buf;
}

function writeAscii(
  buf: Uint8Array,
  offset: number,
  text: string,
  maxLen: number,
) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

describe('mod-parser', () => {
  it('detects a valid 4-channel MOD header', () => {
    const buf = createMinimalModBuffer();
    expect(looksLikeMod(buf)).toBe(true);
  });

  it('parses minimal MOD structure', () => {
    const buf = createMinimalModBuffer();
    const song = parseMod(buf);

    expect(song.title).toBe('TEST MOD');
    expect(song.numChannels).toBe(4);
    expect(song.songLength).toBe(1);
    expect(song.orders[0]).toBe(0);

    expect(song.patterns.length).toBe(1);
    const firstPattern = song.patterns[0];
    expect(firstPattern).toBeDefined();
    if (!firstPattern) return;

    expect(firstPattern.rows.length).toBe(64);
    const firstRow = firstPattern.rows[0];
    expect(firstRow).toBeDefined();
    if (!firstRow) return;
    expect(firstRow.length).toBe(4);

    const firstCell = firstRow[0];
    expect(firstCell).toBeDefined();
    if (!firstCell) return;
    expect(firstCell.sampleNumber).toBe(1);
    expect(firstCell.period).toBe(0x0358);

    expect(song.samples.length).toBe(31);
    const s1 = song.samples[0];
    expect(s1).toBeDefined();
    if (!s1) return;
    expect(s1.name).toBe('SAMPLE1');
    expect(s1.length).toBe(8);
    expect(s1.data.length).toBe(8);
  });
});

import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * 9xx sample offset survives import unchanged.
 *
 * Import used to rewrite the parameter, because the playback effect processor
 * treated it as a 0-1 fraction of the sample (`raw / 255`) instead of
 * ProTracker's absolute `param * 256` frames. Recomputing the fraction from
 * `mod.samples[sampleNumber-1].length` fixed the common case but could only
 * fire on rows that name an instrument, quantised the position back down to
 * eight bits, and did nothing for XM, which does not go through this
 * importer at all.
 *
 * The processor now carries the offset in frames and the instrument resolves
 * it against its own buffer, so the parameter must reach playback untouched.
 * These tests pin that -- in particular that a row *without* an instrument
 * number, which the old fixup silently skipped, is treated no differently.
 */

function writeAscii(buf: Uint8Array, offset: number, text: string, maxLen: number) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

/**
 * Builds a minimal 4-channel MOD with one sample whose length is NOT
 * 65280 bytes (the only length for which the old raw/255 math happened to
 * be correct), and a single row carrying a 9xx sample-offset effect.
 */
function createSampleOffsetModBuffer(): Uint8Array {
  const NUM_CHANNELS = 4;
  const ROWS = 64;
  const HEADER_SIZE = 1084;
  const patternSize = ROWS * NUM_CHANNELS * 4;

  // 10000 bytes -- deliberately far from the 65280-byte length the old
  // (buggy) fixed-255 math implicitly assumed.
  const sampleLengthBytes = 10000;
  const sampleLengthWords = sampleLengthBytes / 2;
  const totalSize = HEADER_SIZE + patternSize + sampleLengthBytes;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'OFFSET TEST', 20);

  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const isSample1 = i === 0;
    const name = isSample1 ? 'SAMPLE1' : '';
    writeAscii(buf, offset, name, 22);

    const lengthWords = isSample1 ? sampleLengthWords : 0;
    view.setUint16(offset + 22, lengthWords, false);

    buf[offset + 24] = 0; // finetune
    buf[offset + 25] = isSample1 ? 64 : 0; // default volume

    view.setUint16(offset + 26, 0, false); // loop start
    view.setUint16(offset + 28, 0, false); // loop length

    offset += 30;
  }

  buf[950] = 1; // song length
  buf[951] = 0;
  buf[952] = 0; // first pattern index
  writeAscii(buf, 1080, 'M.K.', 4);

  const patternDataOffset = HEADER_SIZE;
  const writeCell = (
    row: number,
    ch: number,
    sampleNumber: number,
    period: number,
    effectCmd: number,
    effectParam: number,
  ) => {
    const cellOffset = patternDataOffset + (row * NUM_CHANNELS + ch) * 4;
    const sampleHighNibble = sampleNumber & 0xf0;
    const sampleLowNibble = (sampleNumber & 0x0f) << 4;
    buf[cellOffset] = sampleHighNibble | ((period >> 8) & 0x0f);
    buf[cellOffset + 1] = period & 0xff;
    buf[cellOffset + 2] = sampleLowNibble | (effectCmd & 0x0f);
    buf[cellOffset + 3] = effectParam & 0xff;
  };

  const period = 0x0358; // arbitrary legal period
  // Row 0: note + instrument, 9xx sample offset with param 0x15 (matches
  // the real GSLINGER.MOD "915" effect that led to this investigation).
  writeCell(0, 0, 1, period, 0x9, 0x15);

  return buf;
}

describe('MOD import: 9xx sample offset passes through unchanged', () => {
  it('keeps the raw ProTracker parameter', () => {
    const buf = createSampleOffsetModBuffer();
    const songFile = importModToTrackerSong(buf.buffer);
    const track0 = songFile.data.patterns[0]?.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;

    const row0 = track0.entries.find((e) => e.row === 0);
    expect(row0).toBeDefined();
    if (!row0) return;

    // 0x15 * 256 = 5376 frames into the sample, which is what playback now
    // resolves. The interim fixup rewrote this to "989" (the synthetic byte
    // that reproduced 5376/10000 once divided by 255).
    expect(row0.macro).toBe('915');
  });

  it('is unaffected by a row that names no resolvable sample', () => {
    const buf = createSampleOffsetModBuffer();
    // Corrupt: point the row's sample number at an empty/unused sample
    // slot so mod-import can't resolve a length for it.
    const patternDataOffset = 1084;
    const cellOffset = patternDataOffset + 0 * 4; // row 0, channel 0
    buf[cellOffset] = (5 & 0xf0) | ((0x358 >> 8) & 0x0f);
    buf[cellOffset + 1] = 0x358 & 0xff;
    buf[cellOffset + 2] = ((5 & 0x0f) << 4) | 0x9;
    buf[cellOffset + 3] = 0x15;

    const songFile = importModToTrackerSong(buf.buffer);
    const track0 = songFile.data.patterns[0]?.tracks[0];
    const row0 = track0?.entries.find((e) => e.row === 0);
    expect(row0).toBeDefined();
    if (!row0) return;
    // Same parameter as the resolvable case above: the offset no longer
    // depends on import knowing which sample the row will play.
    expect(row0.macro).toBe('915');
  });
});

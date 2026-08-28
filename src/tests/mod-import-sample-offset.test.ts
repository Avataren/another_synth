import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * Regression coverage for "guitar strumming that doesn't sound right" from
 * a certain point in a MOD file onward -- traced to GSLINGER.MOD, whose
 * second pattern repeatedly retriggers the same note with a 9xx
 * (sample-offset) effect.
 *
 * Root cause: ProTracker's 9xx parameter is a byte offset in units of 256
 * bytes into the *current* sample, but the generic (sample-length-unaware)
 * playback effect processor (packages/tracker-playback/effect-processor.ts)
 * maps the raw 0-255 param straight to a 0-1 "normalized offset" fraction
 * via `raw / 255` -- only correct for a sample that happens to be exactly
 * 255*256 = 65280 bytes long. Any other length (virtually all real
 * samples) lands the playback position at the wrong point in the sample
 * entirely.
 *
 * Fix: mod-import.ts has access to the real sample length at import time
 * (mod.samples[sampleNumber-1].length, already in bytes), so it now
 * recomputes the correct 0-1 fraction there and re-encodes it as a
 * *synthetic* 9xx param -- the value that reproduces the correct fraction
 * once the generic processor later divides it by 255 -- rather than
 * passing the raw MOD param through unchanged.
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

describe('MOD import: 9xx sample offset scales to the real sample length', () => {
  it('re-encodes the offset param using the sample byte length, not a fixed 65280 assumption', () => {
    const buf = createSampleOffsetModBuffer();
    const songFile = importModToTrackerSong(buf.buffer);
    const track0 = songFile.data.patterns[0]?.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;

    const row0 = track0.entries.find((e) => e.row === 0);
    expect(row0).toBeDefined();
    if (!row0) return;

    // effectParam 0x15 (21) * 256 = 5376 bytes into a 10000-byte sample
    // = 0.5376 fraction -> synthetic raw = round(0.5376 * 255) = 137 = 0x89.
    // The old (buggy) behavior would have passed "915" straight through
    // unchanged (raw/255 = 21/255 ≈ 0.0824 -- a completely different,
    // much-too-early position).
    expect(row0.macro).toBe('989');
    expect(row0.macro).not.toBe('915');
  });

  it('falls back to the raw (imprecise) param when the sample length is unknown', () => {
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
    expect(row0.macro).toBe('915');
  });
});

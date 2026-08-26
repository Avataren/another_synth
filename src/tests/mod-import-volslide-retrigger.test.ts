import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * Regression coverage for: "the sound dies after the second note" when a
 * track uses Axy volume-slide-down effects, reported when playing a MOD
 * with rows like `D#2 <sample> .. A0A` immediately followed by more `A0A`/
 * `A00` continuation rows.
 *
 * Root cause: mod-import.ts skipped setting a note's volume-column entry
 * to the triggered sample's default volume whenever the same row also
 * carried a volume-slide effect (Axy/EAx/EBx) -- even when the row was a
 * genuine new note+instrument trigger, not a mid-slide continuation. That
 * left the tracker entry's volume unset, so the playback engine's
 * `currentVolume` (see effect-processor.ts) was never reset on this new
 * note and instead inherited whatever near-zero value the *previous*
 * note's volume slide had decayed to -- which then gets pushed as the
 * fresh note's starting volume by the volSlide tick-0 handling, silencing
 * it almost immediately.
 *
 * Fix: a genuine new note+instrument trigger row always gets its sample's
 * default volume stamped into the volume column, even when an Axy/EAx/EBx
 * effect is present on that same row (matching real ProTracker semantics:
 * instrument default volume is applied on trigger regardless of any
 * accompanying effect). Only tone portamento (3xx/5xy), which doesn't
 * retrigger the sample at all, is still excluded.
 */

function writeAscii(buf: Uint8Array, offset: number, text: string, maxLen: number) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

/**
 * Builds a minimal 4-channel MOD with two samples of different default
 * volumes, and channel 0 playing: row 0 = note on sample 1 (full volume),
 * row 1 = a *new* note on sample 2 (half volume) with an Axy volume-slide
 * effect on the same row.
 */
function createTwoSampleModBuffer(): Uint8Array {
  const NUM_CHANNELS = 4;
  const ROWS = 64;
  const HEADER_SIZE = 1084;
  const patternSize = ROWS * NUM_CHANNELS * 4;

  const sampleLengthWords = 4; // 8 bytes each
  const sampleLengthBytes = sampleLengthWords * 2;
  const totalSize = HEADER_SIZE + patternSize + sampleLengthBytes * 2;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'VOLSLIDE TEST', 20);

  // Sample headers (31 samples, 30 bytes each)
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const isSample1 = i === 0;
    const isSample2 = i === 1;

    const name = isSample1 ? 'SAMPLE1' : isSample2 ? 'SAMPLE2' : '';
    writeAscii(buf, offset, name, 22);

    const lengthWords = isSample1 || isSample2 ? sampleLengthWords : 0;
    view.setUint16(offset + 22, lengthWords, false);

    buf[offset + 24] = 0; // finetune
    // Distinct default volumes so the test can tell which one actually
    // ended up in the tracker entry's volume column.
    buf[offset + 25] = isSample1 ? 64 : isSample2 ? 32 : 0;

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
  // Row 0: plain note on sample 1, no effect.
  writeCell(0, 0, 1, period, 0x0, 0x00);
  // Row 1: a *new* note+instrument on sample 2, same row as A0A (volume
  // slide down by 0xA/tick). This is the scenario from the bug report.
  writeCell(1, 0, 2, period, 0xa, 0x0a);

  const sampleDataOffset = HEADER_SIZE + patternSize;
  // Both samples: silence is fine, only the volume-column value matters.
  for (let i = 0; i < sampleLengthBytes * 2; i++) {
    buf[sampleDataOffset + i] = 0;
  }

  return buf;
}

describe('MOD import: new note + volume slide on the same row', () => {
  it('stamps the new sample default volume instead of leaving it unset', () => {
    const buf = createTwoSampleModBuffer();
    const songFile = importModToTrackerSong(buf.buffer);
    const track0 = songFile.data.patterns[0]?.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;

    const row0 = track0.entries.find((e) => e.row === 0);
    const row1 = track0.entries.find((e) => e.row === 1);
    expect(row0).toBeDefined();
    expect(row1).toBeDefined();
    if (!row0 || !row1) return;

    // Row 0: sample 1, default volume 64/64 -> full scale (0xFF).
    expect(row0.instrument).toBe('01');
    expect(row0.volume).toBe('FF');

    // Row 1: a brand-new note on sample 2 (default volume 32/64 = half),
    // even though it's on the same row as an A0A volume-slide effect.
    // Before the fix, `volume` was left undefined here, letting the
    // playback engine inherit sample 1's already-decayed volume instead.
    expect(row1.instrument).toBe('02');
    expect(row1.volume).toBeDefined();
    expect(row1.volume).not.toBe(row0.volume);
    // 32/64 * 255 rounded = 128 = 0x80
    expect(row1.volume).toBe('80');
  });
});

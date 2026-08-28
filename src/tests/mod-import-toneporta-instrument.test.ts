import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * Regression coverage for "the 3xx effect isn't tuned properly" -- traced
 * to tempest-acidjazz.mod, where a tone-portamento row also specified a
 * *different* sample number than the one currently sounding.
 *
 * Root cause: mod-import.ts stamped entry.instrument from a row's sample
 * number unconditionally, including on tone-portamento rows (3xx/5xy).
 * Real ProTracker semantics: a sample number on a tone-porta row does NOT
 * switch the currently-sounding sample -- the slide continues on whatever
 * instrument is already playing. Because the engine routes each row's
 * pitch-automation command to that row's instrumentId, stamping the new
 * (untriggered) instrument number meant the slide's pitch commands went
 * to an instrument with no active voice, while the instrument actually
 * playing never received the slide at all and stayed stuck at its
 * original pitch -- audibly, the note never reached its intended target
 * and clashed with the rest of the mix ("off tune").
 *
 * Fix: a tone-porta row's sample number is no longer stamped into
 * entry.instrument, so the track builder's sticky last-instrument
 * tracking keeps routing to the instrument that's actually sounding.
 */

function writeAscii(buf: Uint8Array, offset: number, text: string, maxLen: number) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

function createTonePortaInstrumentChangeModBuffer(): Uint8Array {
  const NUM_CHANNELS = 4;
  const ROWS = 64;
  const HEADER_SIZE = 1084;
  const patternSize = ROWS * NUM_CHANNELS * 4;
  const sampleLengthWords = 4;
  const sampleLengthBytes = sampleLengthWords * 2;
  const totalSize = HEADER_SIZE + patternSize + sampleLengthBytes * 2;

  const buf = new Uint8Array(totalSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'TONEPORTA TEST', 20);

  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const isSample1 = i === 0;
    const isSample2 = i === 1;
    const name = isSample1 ? 'SAMPLE1' : isSample2 ? 'SAMPLE2' : '';
    writeAscii(buf, offset, name, 22);
    const lengthWords = isSample1 || isSample2 ? sampleLengthWords : 0;
    view.setUint16(offset + 22, lengthWords, false);
    buf[offset + 24] = 0; // finetune
    buf[offset + 25] = 64; // default volume
    view.setUint16(offset + 26, 0, false);
    view.setUint16(offset + 28, 0, false);
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

  // Row 0: plain trigger on sample 1.
  writeCell(0, 0, 1, 0x0168 /* period 360 */, 0x0, 0x00);
  // Row 1: tone porta (3xx) towards period 320, carrying sample 2 -- real
  // ProTracker keeps playing sample 1; sample 2 must NOT become the row's
  // active instrument.
  writeCell(1, 0, 2, 0x0140 /* period 320 */, 0x3, 0xff);

  return buf;
}

describe('MOD import: tone portamento does not switch the active instrument', () => {
  it('leaves entry.instrument unset on a 3xx row even when a different sample number is given', () => {
    const buf = createTonePortaInstrumentChangeModBuffer();
    const songFile = importModToTrackerSong(buf.buffer);
    const track0 = songFile.data.patterns[0]?.tracks[0];
    expect(track0).toBeDefined();
    if (!track0) return;

    const row0 = track0.entries.find((e) => e.row === 0);
    const row1 = track0.entries.find((e) => e.row === 1);
    expect(row0).toBeDefined();
    expect(row1).toBeDefined();
    if (!row0 || !row1) return;

    expect(row0.instrument).toBe('01');
    expect(row1.instrument).toBeUndefined();
    // The slide effect itself must still be present.
    expect(row1.macro).toBe('3FF');
  });
});

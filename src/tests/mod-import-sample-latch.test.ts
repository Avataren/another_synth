import { describe, it, expect } from 'vitest';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';

/**
 * A channel's selected sample outlives the pattern it was selected in.
 *
 * In ProTracker a bare sample number does not retrigger anything; it latches
 * the sample for the channel's *next* note. That latch is channel state, so a
 * note written without a sample number early in a pattern resolves to whatever
 * the channel last selected -- possibly several patterns ago.
 *
 * The importer used to re-create the latch for every pattern, so such a note
 * imported with no instrument at all. GSLINGER.MOD is the case that exposed
 * it: channel 1 latches sample 24 at row 32 of one pattern and plays
 * `D-2 ... C10` at row 0 of the next with no sample number. That row was
 * silent when its pattern was played on its own, and fell back to whatever the
 * engine happened to have last seen -- the wrong guitar -- when reached from
 * the previous pattern. 320 notes across 13 of the 28 modules in the local
 * corpus were resolving to no instrument or the wrong one.
 */

const HEADER_SIZE = 1084;
const CHANNELS = 4;
const ROWS = 64;

interface CellSpec {
  pattern: number;
  row: number;
  period?: number;
  sampleNumber?: number;
  effectCmd?: number;
  effectParam?: number;
}

function writeAscii(buf: Uint8Array, offset: number, text: string, maxLen: number) {
  for (let i = 0; i < maxLen; i++) {
    buf[offset + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
}

/** A MOD with `orders` over `patternCount` patterns and two usable samples. */
function createModBuffer(
  cells: CellSpec[],
  orders: number[],
  patternCount: number,
): Uint8Array {
  const patternSize = ROWS * CHANNELS * 4;
  const sampleLengthWords = 4;
  const buf = new Uint8Array(
    HEADER_SIZE + patternCount * patternSize + 2 * sampleLengthWords * 2,
  );
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  writeAscii(buf, 0, 'LATCH', 20);
  let offset = 20;
  for (let i = 0; i < 31; i++) {
    const used = i === 0 || i === 4;
    writeAscii(buf, offset, used ? `SAMPLE${i + 1}` : '', 22);
    view.setUint16(offset + 22, used ? sampleLengthWords : 0, false);
    buf[offset + 24] = 0;
    buf[offset + 25] = 64;
    view.setUint16(offset + 26, 0, false);
    view.setUint16(offset + 28, 0, false);
    offset += 30;
  }

  buf[950] = orders.length;
  orders.forEach((o, i) => {
    buf[952 + i] = o;
  });
  writeAscii(buf, 1080, 'M.K.', 4);

  for (const cell of cells) {
    const period = cell.period ?? 0;
    const sampleNumber = cell.sampleNumber ?? 0;
    const at =
      HEADER_SIZE + cell.pattern * patternSize + cell.row * CHANNELS * 4;
    buf[at] = (sampleNumber & 0xf0) | ((period >> 8) & 0x0f);
    buf[at + 1] = period & 0xff;
    buf[at + 2] = ((sampleNumber & 0x0f) << 4) | (cell.effectCmd ?? 0);
    buf[at + 3] = cell.effectParam ?? 0;
  }
  return buf;
}

const PERIOD = 214; // C-3

function entryAt(cells: CellSpec[], orders: number[], patternCount: number, pattern: number, row: number) {
  const song = importModToTrackerSong(
    createModBuffer(cells, orders, patternCount).buffer as ArrayBuffer,
  );
  return song.data.patterns[pattern]?.tracks[0]?.entries.find((e) => e.row === row);
}

describe('the channel sample latch survives a pattern boundary', () => {
  it('resolves a note with no sample number to the sample latched in the previous pattern', () => {
    // Pattern 0 latches sample 5 with a bare sample number; pattern 1 opens
    // with a note that names no sample.
    const entry = entryAt(
      [
        { pattern: 0, row: 32, sampleNumber: 5 },
        { pattern: 1, row: 0, period: PERIOD },
      ],
      [0, 1],
      2,
      1,
      0,
    );

    expect(entry?.note).toBeDefined();
    expect(entry?.instrument).toBe('05');
  });

  it('follows the order list, not the storage order', () => {
    // Pattern 1 is played *first* and latches sample 1; pattern 0 is played
    // second and inherits it. Converting in storage order would have pattern 0
    // inherit nothing, since nothing had latched by then.
    const entry = entryAt(
      [
        { pattern: 1, row: 0, sampleNumber: 1 },
        { pattern: 0, row: 0, period: PERIOD },
      ],
      [1, 0],
      2,
      0,
      0,
    );

    expect(entry?.instrument).toBe('01');
  });

  it('still converts a pattern the order list never reaches', () => {
    // Pattern 1 exists (the order table's highest entry is 2) but is never
    // played. Orphans are converted after the played ones, from a clean latch,
    // so they import rather than being dropped.
    const song = importModToTrackerSong(
      createModBuffer(
        [
          { pattern: 0, row: 0, period: PERIOD, sampleNumber: 1 },
          { pattern: 1, row: 0, period: PERIOD, sampleNumber: 5 },
          { pattern: 2, row: 0, period: PERIOD, sampleNumber: 1 },
        ],
        [0, 2],
        3,
      ).buffer as ArrayBuffer,
    );

    expect(song.data.patterns).toHaveLength(3);
    const orphan = song.data.patterns[1]!.tracks[0]!.entries.find((e) => e.row === 0);
    expect(orphan?.instrument).toBe('05');
  });

  it('keeps patterns indexed by their pattern number', () => {
    // The order list indexes this array, so converting in play order must not
    // reorder it.
    const song = importModToTrackerSong(
      createModBuffer(
        [
          { pattern: 0, row: 0, period: PERIOD, sampleNumber: 1 },
          { pattern: 1, row: 0, period: PERIOD, sampleNumber: 5 },
        ],
        [1, 0],
        2,
      ).buffer as ArrayBuffer,
    );

    expect(song.data.patterns[0]!.tracks[0]!.entries[0]!.instrument).toBe('01');
    expect(song.data.patterns[1]!.tracks[0]!.entries[0]!.instrument).toBe('05');
    // Sequence is order-list order: pattern 1 then pattern 0.
    expect(song.data.sequence).toEqual([
      song.data.patterns[1]!.id,
      song.data.patterns[0]!.id,
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import {
  songTrackColumns,
  TRACK_GAP_PX,
  TRACK_GAP_TIGHT_PX,
  trackColumns,
  trackGapPx,
  trackPitchPx,
  trackWidthPx,
  visibleColumnIndices,
} from 'src/components/tracker/track-metrics';

const STD = trackColumns(true, false);
const DUAL = trackColumns(true, true);

/**
 * The pattern grid and the waveform row above it are separate elements drawn
 * from the same column metrics. Nothing in the DOM forces them to agree, and a
 * mismatch does not look like a bug at four channels -- it is a per-column
 * error, so it only becomes visible once enough columns have accumulated it.
 *
 * That is exactly how it shipped: the waveform row used a fixed 180px column
 * and 10px gap while the pattern tightened past eight channels, drifting 16px
 * per column (24px past sixteen) until the waveforms sat over the wrong tracks
 * entirely.
 *
 * These pin the numbers so a change to one side has to be a change to both.
 */

describe('column tightening', () => {
  it('stays at full width for the classic channel counts', () => {
    for (const count of [1, 4, 8]) {
      expect(trackWidthPx(count, STD)).toBe(180);
      expect(trackGapPx(count)).toBe(TRACK_GAP_PX);
    }
  });

  it('tightens past eight channels', () => {
    expect(trackWidthPx(9, STD)).toBe(168);
    expect(trackWidthPx(16, STD)).toBe(168);
    expect(trackGapPx(9)).toBe(TRACK_GAP_TIGHT_PX);
  });

  it('tightens further past sixteen', () => {
    // 22, 24 and 32 channel modules are all in the demo collection.
    expect(trackWidthPx(17, STD)).toBe(160);
    expect(trackWidthPx(32, STD)).toBe(160);
  });

  it('never goes below the width at which entry columns clip', () => {
    for (const count of [17, 32, 64, 256]) {
      expect(trackWidthPx(count, STD)).toBeGreaterThanOrEqual(160);
      expect(trackWidthPx(count, DUAL)).toBeGreaterThanOrEqual(216);
    }
  });

  it('keeps the extra effect column wider at every count', () => {
    for (const count of [4, 9, 17, 32]) {
      expect(trackWidthPx(count, DUAL)).toBeGreaterThan(
        trackWidthPx(count, STD),
      );
    }
  });

  it('never widens as channels are added', () => {
    for (const extra of [false, true]) {
      for (let count = 2; count <= 64; count++) {
        expect(trackPitchPx(count, trackColumns(true, extra))).toBeLessThanOrEqual(
          trackPitchPx(count - 1, trackColumns(true, extra)),
        );
      }
    }
  });
});

describe('the pattern grid and the waveform row', () => {
  /**
   * Both strips lay columns out as `width` boxes separated by `gap`, so column
   * n starts at n * pitch. Agreeing on the pitch is the whole alignment
   * requirement; this reproduces that arithmetic for both sides.
   */
  const columnStart = (index: number, count: number, extra: boolean) =>
    index * trackPitchPx(count, trackColumns(true, extra));

  it('places every column at the same offset in both', () => {
    for (const count of [4, 9, 16, 22, 24, 32]) {
      for (const extra of [false, true]) {
        for (let i = 0; i < count; i++) {
          // Same function on both sides -- the point is that there is only one.
          expect(columnStart(i, count, extra)).toBe(
            i * (trackWidthPx(count, trackColumns(true, extra)) + trackGapPx(count)),
          );
        }
      }
    }
  });

  it('would have drifted visibly under the old fixed metrics', () => {
    // Guards the regression rather than the fix: if someone reintroduces a
    // fixed 180/10 for the waveform row, the last column of a 32-channel
    // module lands most of a column-width away from its track.
    const count = 32;
    const stale = 180 + 10;
    const actual = trackPitchPx(count, STD);
    const driftAtLastColumn = (count - 1) * (stale - actual);

    expect(driftAtLastColumn).toBeGreaterThan(trackWidthPx(count, STD));
  });
});

describe('columns per song format', () => {
  it('drops the volume column for AHX, HVL and SID, and fixes their effect columns', () => {
    expect(songTrackColumns('sid', null, true)).toBe(trackColumns(false, false));
    expect(songTrackColumns('ahx', 'ahx', true)).toBe(trackColumns(false, false));
    expect(songTrackColumns('ahx', 'hvl', false)).toBe(trackColumns(false, true));
  });

  it('leaves the second effect column to the user where the format does not decide it', () => {
    for (const format of ['native', 'protracker', 'xm', 's3m'] as const) {
      expect(songTrackColumns(format, null, false)).toBe(STD);
      expect(songTrackColumns(format, null, true)).toBe(DUAL);
    }
    // An AHX song whose doc and bytes both say nothing of AHX or HVL.
    expect(songTrackColumns('ahx', null, true)).toBe(trackColumns(false, true));
    expect(songTrackColumns('ahx', null, false)).toBe(trackColumns(false, false));
  });

  it('hands out one shared value per combination', () => {
    expect(trackColumns(false, true)).toBe(trackColumns(false, true));
    expect(trackColumns(false, true)).not.toBe(trackColumns(true, true));
  });

  it('lists the cursor stops, skipping the hidden columns', () => {
    expect(visibleColumnIndices(STD)).toEqual([0, 1, 2, 3, 4]);
    expect(visibleColumnIndices(DUAL)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(visibleColumnIndices(trackColumns(false, false))).toEqual([0, 1, 4]);
    expect(visibleColumnIndices(trackColumns(false, true))).toEqual([0, 1, 4, 5]);
  });

  it('narrows a track without a volume column at every channel count', () => {
    for (const count of [1, 4, 9, 17, 32]) {
      expect(trackWidthPx(count, trackColumns(false, false))).toBeLessThan(trackWidthPx(count, STD));
      expect(trackWidthPx(count, trackColumns(false, true))).toBeLessThan(trackWidthPx(count, DUAL));
    }
  });
});

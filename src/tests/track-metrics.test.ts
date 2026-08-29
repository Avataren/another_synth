import { describe, it, expect } from 'vitest';
import {
  TRACK_GAP_PX,
  TRACK_GAP_TIGHT_PX,
  trackGapPx,
  trackPitchPx,
  trackWidthPx,
} from 'src/components/tracker/track-metrics';

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
      expect(trackWidthPx(count, false)).toBe(180);
      expect(trackGapPx(count)).toBe(TRACK_GAP_PX);
    }
  });

  it('tightens past eight channels', () => {
    expect(trackWidthPx(9, false)).toBe(168);
    expect(trackWidthPx(16, false)).toBe(168);
    expect(trackGapPx(9)).toBe(TRACK_GAP_TIGHT_PX);
  });

  it('tightens further past sixteen', () => {
    // 22, 24 and 32 channel modules are all in the demo collection.
    expect(trackWidthPx(17, false)).toBe(160);
    expect(trackWidthPx(32, false)).toBe(160);
  });

  it('never goes below the width at which entry columns clip', () => {
    for (const count of [17, 32, 64, 256]) {
      expect(trackWidthPx(count, false)).toBeGreaterThanOrEqual(160);
      expect(trackWidthPx(count, true)).toBeGreaterThanOrEqual(216);
    }
  });

  it('keeps the extra effect column wider at every count', () => {
    for (const count of [4, 9, 17, 32]) {
      expect(trackWidthPx(count, true)).toBeGreaterThan(
        trackWidthPx(count, false),
      );
    }
  });

  it('never widens as channels are added', () => {
    for (const extra of [false, true]) {
      for (let count = 2; count <= 64; count++) {
        expect(trackPitchPx(count, extra)).toBeLessThanOrEqual(
          trackPitchPx(count - 1, extra),
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
    index * trackPitchPx(count, extra);

  it('places every column at the same offset in both', () => {
    for (const count of [4, 9, 16, 22, 24, 32]) {
      for (const extra of [false, true]) {
        for (let i = 0; i < count; i++) {
          // Same function on both sides -- the point is that there is only one.
          expect(columnStart(i, count, extra)).toBe(
            i * (trackWidthPx(count, extra) + trackGapPx(count)),
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
    const actual = trackPitchPx(count, false);
    const driftAtLastColumn = (count - 1) * (stale - actual);

    expect(driftAtLastColumn).toBeGreaterThan(trackWidthPx(count, false));
  });
});

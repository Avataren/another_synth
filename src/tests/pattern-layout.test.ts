import { describe, it, expect } from 'vitest';
import {
  GUTTER_WIDTH_PX,
  headerHeightPx,
  entryHorizontalInsetPx,
  macroNibbleWidth,
  buildEntryLookup,
  columnFractionOffsets,
  entryBoxRect,
  rowGapPx,
  rowHeightPx,
  rowPitchPx,
  rowY,
  patternPanelWidth,
  reservedSideGutterPx,
  totalTracksWidth,
  PANEL_CHROME_PX,
  type PatternLayout,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { trackWidthPx } from 'src/components/tracker/track-metrics';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * The canvas pattern renderer draws clicks and cells onto the same pixels the
 * DOM grid used to own. TrackerEntry's CSS grid (`1.6fr 1fr 0.35fr 0.35fr
 * 1.8fr`, +1.5fr/1.5fr in dual mode), its 30px rows with 6px gaps, and its
 * 10px+border insets are all re-derived here in arithmetic; if the canvas
 * disagrees with the DOM by even a fraction of a column, clicks land on the
 * wrong cell and drawn cells sit under the wrong text. These tests pin the
 * numbers and the arithmetic shape.
 */

const layout = (trackCount = 4, showExtraEffectColumn = false, rowCount = 64): PatternLayout => ({
  trackCount,
  showExtraEffectColumn,
  rowCount,
});

describe('row metrics', () => {
  it('keeps the constants TrackerEntry and TrackerPattern hard-code', () => {
    expect(rowHeightPx).toBe(30);
    expect(rowGapPx).toBe(6);
    expect(headerHeightPx).toBe(46);
    expect(rowPitchPx).toBe(36);
  });

  it('places row n exactly one pitch below row n-1', () => {
    expect(rowY(0)).toBe(0);
    expect(rowY(1)).toBe(36);
    expect(rowY(16)).toBe(16 * 36);
  });
});

describe('totalTracksWidth', () => {
  it('has no trailing gap after the last column', () => {
    // Width of n columns + (n-1) gaps; re-derived from track-metrics.
    expect(totalTracksWidth(1, false)).toBe(180);
    expect(totalTracksWidth(2, false)).toBe(180 + 10 + 180);
    expect(totalTracksWidth(4, true)).toBe(4 * 240 + 3 * 10);
  });

  it('uses the tightened pitch past eight channels', () => {
    expect(totalTracksWidth(9, false)).toBe(9 * 168 + 8 * 6);
  });

  it('is zero for an empty pattern', () => {
    expect(totalTracksWidth(0, false)).toBe(0);
  });
});

describe('entryBoxRect', () => {
  it('sits at the track pitch and row pitch', () => {
    const rect = entryBoxRect(2, 5, layout());
    expect(rect.x).toBe(2 * (180 + 10));
    expect(rect.y).toBe(rowY(5));
    expect(rect.width).toBe(180);
    expect(rect.height).toBe(30);
  });

  it('is wider in dual-effect mode', () => {
    expect(entryBoxRect(0, 0, layout(4, true)).width).toBe(240);
  });
});

describe('columnFractionOffsets', () => {
  it('reproduces the five CSS fr ratios', () => {
    const content = 180 - 2 * entryHorizontalInsetPx;
    const unit = content / (1.6 + 1 + 0.35 + 0.35 + 1.8);
    const offsets = columnFractionOffsets(180, false);
    expect(offsets).toHaveLength(6);
    expect(offsets[1]).toBeCloseTo(1.6 * unit, 6);
    expect(offsets[2]).toBeCloseTo(2.6 * unit, 6);
    expect(offsets[3]).toBeCloseTo(2.95 * unit, 6);
    expect(offsets[4]).toBeCloseTo(3.3 * unit, 6);
    expect(offsets[5]).toBeCloseTo(content, 6);
  });

  it('reproduces the dual-effect six-column ratios', () => {
    const content = 240 - 2 * entryHorizontalInsetPx;
    const unit = content / (1.6 + 1 + 0.35 + 0.35 + 1.5 + 1.5);
    const offsets = columnFractionOffsets(240, true);
    expect(offsets).toHaveLength(7);
    expect(offsets[5]).toBeCloseTo(4.8 * unit, 6);
    expect(offsets[6]).toBeCloseTo(content, 6);
  });

  it('starts every column set at the content origin', () => {
    expect(columnFractionOffsets(180, false)[0]).toBe(0);
    expect(columnFractionOffsets(240, true)[0]).toBe(0);
  });
});

describe('macroNibbleWidth', () => {
  it('is one third of the effect column, either mode', () => {
    const offsets5 = columnFractionOffsets(180, false);
    expect(macroNibbleWidth(180, false)).toBeCloseTo((offsets5[5] - offsets5[4]) / 3, 6);

    const offsets6 = columnFractionOffsets(240, true);
    expect(macroNibbleWidth(240, true)).toBeCloseTo((offsets6[5] - offsets6[4]) / 3, 6);
  });

  it('keeps nibbles equal width within their column', () => {
    const w = macroNibbleWidth(180, false);
    // Three nibbles tile the effect column exactly.
    expect(3 * w).toBeCloseTo(columnFractionOffsets(180, false)[5] - columnFractionOffsets(180, false)[4], 6);
  });
});

describe('panel width and analyser gutter reserve', () => {
  it('sizes the panel to the content width plus its chrome', () => {
    // 18px padding per side + 1px border per side.
    expect(PANEL_CHROME_PX).toBe(38);
    expect(patternPanelWidth(GUTTER_WIDTH_PX + totalTracksWidth(2, false))).toBe(448 + 38);
    expect(patternPanelWidth(GUTTER_WIDTH_PX + totalTracksWidth(4, false))).toBe(828 + 38);
  });

  it('stays at the natural width for a small song (no viewport fill)', () => {
    // Bug 2: the DOM grid renders a 4ch song as a narrow centered grid. The
    // panel width must derive from the content, never from the viewport, so
    // the page centers it with room for the analyser around it.
    const content = GUTTER_WIDTH_PX + totalTracksWidth(4, false);
    expect(patternPanelWidth(content)).toBeLessThan(1000);
  });

  it('reserves one track column per side when the analyser is on', () => {
    expect(reservedSideGutterPx(true, 4, false, 4000)).toBe(trackWidthPx(4, false));
    expect(reservedSideGutterPx(true, 2, false, 4000)).toBe(trackWidthPx(2, false));
  });

  it('caps the reserve at 15% of the available width', () => {
    expect(reservedSideGutterPx(true, 4, false, 1000)).toBe(150);
    expect(reservedSideGutterPx(true, 4, false, 100)).toBe(15);
  });

  it('reserves nothing when the analyser is off', () => {
    expect(reservedSideGutterPx(false, 4, false, 4000)).toBe(0);
  });
});

describe('buildEntryLookup', () => {
  it('maps rows to entries by their row field, not array position', () => {
    const track: TrackerTrackData = {
      id: 't1',
      name: 'T1',
      entries: [
        { row: 4, note: 'C-4' },
        { row: 0, note: '---' },
        { row: 16, note: '###' },
      ],
    };
    const lookup = buildEntryLookup(track);
    expect(lookup.size).toBe(3);
    expect(lookup.get(0)?.note).toBe('---');
    expect(lookup.get(4)?.note).toBe('C-4');
    expect(lookup.get(16)?.note).toBe('###');
    expect(lookup.get(1)).toBeUndefined();
  });

  it('keeps the last entry when a row is duplicated', () => {
    const track: TrackerTrackData = {
      id: 't1',
      name: 'T1',
      entries: [
        { row: 2, note: 'C-4' },
        { row: 2, note: 'D-4' },
      ],
    };
    expect(buildEntryLookup(track).get(2)?.note).toBe('D-4');
  });
});

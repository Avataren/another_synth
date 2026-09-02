import { describe, it, expect } from 'vitest';
import {
  GUTTER_WIDTH_PX,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import {
  trackGapPx,
  trackPitchPx,
  trackWidthPx,
} from 'src/components/tracker/track-metrics';
import {
  canvasVisualizerPadding,
  domVisualizerPadding,
  VISUALIZER_ROW_GAP_PX,
  VISUALIZER_SPACER_PX,
  VISUALIZER_PADDING_BIAS,
} from 'src/components/tracker/visualizer-alignment';

/**
 * The waveform strip sits in its own element above the pattern, so nothing in
 * the DOM forces the two to agree — only the computed inline padding does.
 * Under the DOM grid the padding was measured against the panel's border box
 * with a fudge bias; commit edaedd8 wired the canvas renderer in without any
 * measurement at all, so the strip kept its stale 18px pads and every
 * waveform drifted off the track it meters (the canvas panel is
 * shrink-to-fit and centered, unlike the full-width DOM panel).
 *
 * These tests pin the padding arithmetic for both renderers, and — the real
 * requirement — that a strip scrolled to the canvas's own scroll offset puts
 * each column origin exactly over its track, at every scroll position.
 */

const columnStart = (index: number, count: number, extra: boolean) =>
  index * trackPitchPx(count, extra);

describe('DOM grid padding (measured against the panel border box)', () => {
  it('reproduces the historic measurement', () => {
    const padding = domVisualizerPadding(
      { left: 0, right: 1000 },
      { left: 100, right: 900 },
    );
    expect(padding).toEqual({
      left: 100 + VISUALIZER_PADDING_BIAS,
      right: 1000 - 900 - VISUALIZER_PADDING_BIAS,
    });
  });

  it('never goes negative', () => {
    const padding = domVisualizerPadding(
      { left: 500, right: 600 },
      { left: 0, right: 1000 },
    );
    expect(padding.left).toBe(0);
    expect(padding.right).toBe(0);
  });
});

describe('canvas renderer padding', () => {
  it('places the first column origin over the bitmap gutter boundary', () => {
    // Row element starts at x=0; the canvas scroller at x=100.
    const padding = canvasVisualizerPadding(
      { left: 0, right: 2000 },
      100,
      800,
    );
    // Strip content starts at spacer + gap + pad...
    const stripContentStart =
      VISUALIZER_SPACER_PX + VISUALIZER_ROW_GAP_PX + padding.left;
    // ...and must equal the scroller's left edge plus the painted gutter,
    // i.e. exactly where track 0's bitmap column begins on screen.
    expect(stripContentStart).toBe(100 + GUTTER_WIDTH_PX);
  });

  it('keeps the strip columns locked to the track columns under scroll', () => {
    // At scroll offset S the bitmap shifts left by S on screen; the strip
    // (an independent scroll container) shifts by its own S. They stay locked
    // only if both sides have the same scrollable extent, i.e. run out of
    // scroll together: then every offset maps 1:1 and column n of the strip
    // sits over column n of the bitmap at scrollLeft 0, S, and max.
    //
    // Geometry: .visualizer-tracks is the row's grid cell after the 78px
    // spacer + 12px gap, shrunk by the row's inline pads; its content is the
    // track cells. The bitmap's viewport is the canvas scroller, client C.
    for (const count of [4, 9, 17, 24, 32]) {
      const extra = false;
      const tracksWidth = totalTracksWidth(count, extra);
      // Row spanning [0, R]; scroller starting at S with client width C.
      const R = 1600;
      const S = 40;
      const C = 1100;
      const pads = canvasVisualizerPadding({ left: 0, right: R }, S, C);
      // Strip client width from the row's grid layout minus the pads.
      const stripClient = R - VISUALIZER_SPACER_PX - VISUALIZER_ROW_GAP_PX - pads.left - pads.right;
      // Strip scrollWidth is just its cells: N*W + (N-1)*G.
      const stripScrollWidth = (count - 1) * trackPitchPx(count, extra) + trackWidthPx(count, extra);
      const stripExtent = stripScrollWidth - stripClient;
      // The bitmap's own horizontal extent: content (gutter + tracks) minus
      // the viewport. Equal extents => 1:1 offset mapping at every position.
      expect(stripExtent).toBe(tracksWidth + GUTTER_WIDTH_PX - C);
    }
  });

  it('matches the gap value the strip stylesheet and the grid share', () => {
    // The strip uses --tracker-track-gap; the grid uses trackGapPx. The pad
    // math assumes the strip's inter-column gap is the shared one.
    expect(trackGapPx(32)).toBe(6);
    expect(trackGapPx(4)).toBe(10);
  });

  it('never produces a negative pad even for a tight window', () => {
    const padding = canvasVisualizerPadding(
      { left: 900, right: 1000 },
      0,
      100,
    );
    expect(padding.left).toBeGreaterThanOrEqual(0);
    expect(padding.right).toBeGreaterThanOrEqual(0);
  });

  it('keeps every column aligned across channel counts at scroll 0', () => {
    for (const count of [4, 8, 9, 16, 17, 24, 32]) {
      const extra = false;
      const padding = canvasVisualizerPadding(
        { left: 0, right: 3000 },
        60,
        1200,
      );
      const stripOrigin = VISUALIZER_SPACER_PX + VISUALIZER_ROW_GAP_PX + padding.left;
      // Column n of the strip sits at stripOrigin + columnStart(n)...
      const stripColumnN = stripOrigin + columnStart(3, count, extra);
      // ...and column n of the bitmap on screen at scrollerLeft + gutter +
      // columnStart(n) — with the scroller at 60, these must coincide.
      expect(stripColumnN).toBe(60 + GUTTER_WIDTH_PX + columnStart(3, count, extra));
    }
  });
});

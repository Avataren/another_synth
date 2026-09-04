/**
 * Horizontal padding for the waveform row above the pattern.
 *
 * The row is a grid of [78px spacer | 12px gap | track strip], and its inline
 * padding is computed so the strip's columns land exactly over the pattern's
 * track columns. The pattern underneath is either the DOM grid
 * (TrackerPattern) or the canvas renderer (PatternCanvas) — different
 * elements with different geometry — so each renderer gets its own
 * measurement, and both must produce a strip whose column n starts where the
 * pattern's column n starts at every shared scroll offset.
 */

import { GUTTER_WIDTH_PX } from './pattern-canvas/pattern-layout';

/** .visualizer-row's fixed leading spacer column (stylesheet mirror). */
export const VISUALIZER_SPACER_PX = 78;
/** .visualizer-row's grid gap between spacer and strip (stylesheet mirror). */
export const VISUALIZER_ROW_GAP_PX = 12;

/**
 * Slack added to the DOM-grid measurement. Historic: the strip's leading
 * spacer + gap were reconciled against the DOM panel's padding, gutter and
 * border by eye; changing it shifts every waveform sideways, so it is pinned
 * here rather than recomputed.
 */
export const VISUALIZER_PADDING_BIAS = 25;

export interface HorizontalRect {
  left: number;
  right: number;
}

/**
 * DOM grid: the strip pads out from the pattern panel's border box.
 */
export function domVisualizerPadding(
  rowRect: HorizontalRect,
  patternRect: HorizontalRect,
): { left: number; right: number } {
  return {
    left: Math.max(
      0,
      patternRect.left - rowRect.left + VISUALIZER_PADDING_BIAS,
    ),
    right: Math.max(
      0,
      rowRect.right - patternRect.right - VISUALIZER_PADDING_BIAS,
    ),
  };
}

/**
 * Canvas renderer: measure the scroller, whose box is exactly the bitmap's
 * viewport — its left edge is the painted row-number gutter's left edge, and
 * the track columns start GUTTER_WIDTH_PX into the bitmap.
 *
 * The strip's leading spacer (78px) deliberately equals the bitmap's gutter
 * (78px), so they cancel and the column origins coincide:
 *
 *   left = scrollerLeft - rowLeft + GUTTER - SPACER - GAP
 *
 * The right pad closes the strip's scroll extent to the bitmap's: it makes
 * the strip's client width `scrollerWidth - GUTTER`, so
 * (stripScrollWidth - stripClient) == (bitmapContent - scrollerWidth) and
 * both sides run out of scroll together — every scroll offset then maps 1:1
 * and each waveform stays over its track at every position, not just at 0.
 */
export function canvasVisualizerPadding(
  rowRect: HorizontalRect,
  scrollerLeft: number,
  scrollerClientWidth: number,
): { left: number; right: number } {
  return {
    left: Math.max(
      0,
      scrollerLeft -
        rowRect.left +
        GUTTER_WIDTH_PX -
        VISUALIZER_SPACER_PX -
        VISUALIZER_ROW_GAP_PX,
    ),
    right: Math.max(0, rowRect.right - (scrollerLeft + scrollerClientWidth)),
  };
}

/** The horizontal scroll geometry of one element, as the sync reads it. */
export interface ScrollExtent {
  scrollWidth: number;
  clientWidth: number;
}

/**
 * How far the tracks can scroll horizontally, from whichever element owns the
 * extent.
 *
 * With the DOM grid that is the pattern's own tracks wrapper: it both
 * produces the scroll and bounds it. The canvas renderer has no such element
 * -- it paints the tracks into a bitmap and drives horizontal position from
 * its own hscroll proxy -- so under the canvas the wrapper is permanently
 * null, and a sync that required it did nothing at all: the waveform strip
 * above the tracks never moved with the pattern (Morten, 2026-09-04).
 *
 * Returns null when neither element exists, which is the only case where
 * there is genuinely nothing to sync.
 */
export function trackScrollMaxima(
  patternWrapper: ScrollExtent | null,
  canvasHScroll: ScrollExtent | null,
): number | null {
  const source = patternWrapper ?? canvasHScroll;
  if (!source) return null;
  return Math.max(0, source.scrollWidth - source.clientWidth);
}

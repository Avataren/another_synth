/**
 * Upcoming-pattern pre-render for the canvas pattern renderer (§3.2).
 *
 * The DOM grid pre-rendered the pattern coming next into a hidden buffer so
 * a playback swap painted no blank frame. The canvas renderer does the same
 * with bitmaps: while playing, the upcoming pattern is painted into a second
 * offscreen surface off the critical path, and a swap is a pointer swap plus
 * one blit — no raster dependency.
 *
 * Pure module: paints into a caller-provided surface and decides whether a
 * finished pre-render is still adoptable; the component owns scheduling
 * (idle/rAF) and the bitmap variables. A jsdom recording context stands in
 * for the real 2D context in tests, exactly as in pattern-draw.
 */

import { GUTTER_WIDTH_PX, rowY, totalTracksWidth, type PatternLayout } from './pattern-layout';
import { drawRowNumbers, drawSelectionBar, drawStaticGrid } from './pattern-draw';
import { getTheme } from './pattern-theme';
import type { UpcomingPatternInfo } from '../pattern-buffering';
import type {
  TrackerInterpolationRange,
  TrackerSelectionRect,
  TrackerTrackData,
} from '../tracker-types';

/**
 * What a painted pre-render bitmap holds, for the adoption check at swap
 * time. Content is recorded by reference — the same rule the cell diff
 * uses: the editing composables replace entry objects on every keystroke,
 * so identical references mean the painted bitmap still shows what the
 * pattern now contains.
 */
/** Per-track painted-content references (identity-diffed at swap time). */
export interface PaintedTrackRefs {
  entries: TrackerTrackData['entries'];
  interpolations: TrackerInterpolationRange[] | undefined;
}

export interface PreRenderMeta {
  upcomingId: string;
  /** Per-track content references the bitmap was painted from. */
  tracks: PaintedTrackRefs[];
  rows: number;
  showExtraEffectColumn: boolean;
  selection: TrackerSelectionRect | null;
  /** CSS extent the bitmap was sized for (device size = ceil(css × dpr)). */
  cssWidth: number;
  cssHeight: number;
}

/** Bitmap extent (CSS px) a pre-render for `info` must be sized for. */
export function preRenderExtent(
  info: UpcomingPatternInfo,
  showExtraEffectColumn: boolean,
): { width: number; height: number } {
  return {
    width: GUTTER_WIDTH_PX + totalTracksWidth(info.tracks.length, showExtraEffectColumn),
    height: rowY(info.rows),
  };
}

/** Snapshot the tracks a pre-render was (or is about to be) painted from. */
export function metaFromInfo(
  info: UpcomingPatternInfo,
  showExtraEffectColumn: boolean,
  selection: TrackerSelectionRect | null,
): PreRenderMeta {
  const extent = preRenderExtent(info, showExtraEffectColumn);
  return {
    upcomingId: info.id,
    tracks: info.tracks.map((track) => ({
      entries: track.entries,
      interpolations: track.interpolations,
    })),
    rows: info.rows,
    showExtraEffectColumn,
    selection: selection ? { ...selection } : null,
    cssWidth: extent.width,
    cssHeight: extent.height,
  };
}

/**
 * Paint `upcoming` into `surface` exactly as the component's paintStatic
 * paints the current pattern (same theme, same draw ops), except the surface
 * is taken as-is: no allocation, no size writes — the caller sizes it for
 * this pattern's extent and may hand it an OffscreenCanvas.
 *
 * The selection highlight bakes in for the same reason paintStatic draws it:
 * the swap adopter skips the static paint, so anything paintStatic would
 * have shown must already be in the bitmap. Returns false when the surface
 * has no 2D context — the caller treats that like any renderer failure.
 */
export function paintUpcoming(
  surface: HTMLCanvasElement | OffscreenCanvas,
  upcoming: UpcomingPatternInfo,
  showExtraEffectColumn: boolean,
  selection: TrackerSelectionRect | null,
): boolean {
  const rawCtx = surface.getContext('2d');
  if (!rawCtx) return false;
  const ctx = rawCtx as unknown as CanvasRenderingContext2D;
  const theme = getTheme();
  const l: PatternLayout = {
    trackCount: upcoming.tracks.length,
    showExtraEffectColumn,
    rowCount: upcoming.rows,
  };

  ctx.clearRect(0, 0, surface.width, surface.height);
  ctx.fillStyle = theme.panelBackground;
  ctx.fillRect(0, 0, surface.width, surface.height);
  drawRowNumbers(ctx, l, theme, { selection });
  ctx.save();
  ctx.translate(GUTTER_WIDTH_PX, 0);
  drawStaticGrid(ctx, l, theme, { tracks: upcoming.tracks, selection });
  if (selection) {
    drawSelectionBar(ctx, l, theme, { selection });
  }
  ctx.restore();
  return true;
}

/**
 * Whether a finished pre-render can be adopted on a swap without repainting:
 * the bitmap must hold the very pattern arriving now — `tracks`/`rows` are
 * the component's updated props (props.tracks is already the new pattern
 * when the swap's static repaint is scheduled) — painted for the current
 * dual-effect flag and selection, from the same edit-generation of every
 * track. An edit to the upcoming pattern after the pre-render replaced the
 * entry objects, so the references no longer match and the swap falls back
 * to a full paint.
 */
export function canAdoptPreRender(
  meta: PreRenderMeta | null,
  tracks: TrackerTrackData[] | null,
  rows: number,
  showExtraEffectColumn: boolean,
  selection: TrackerSelectionRect | null,
): boolean {
  if (!meta || !tracks) return false;
  if (meta.rows !== rows) return false;
  if (meta.showExtraEffectColumn !== showExtraEffectColumn) return false;
  if (meta.tracks.length !== tracks.length) return false;
  for (let i = 0; i < meta.tracks.length; i++) {
    const painted = meta.tracks[i]!;
    const current = tracks[i]!;
    if (painted.entries !== current.entries) return false;
    if (painted.interpolations !== current.interpolations) return false;
  }
  if ((meta.selection === null) !== (selection === null)) return false;
  if (
    meta.selection !== null &&
    selection !== null &&
    (meta.selection.rowStart !== selection.rowStart ||
      meta.selection.rowEnd !== selection.rowEnd ||
      meta.selection.trackStart !== selection.trackStart ||
      meta.selection.trackEnd !== selection.trackEnd)
  ) {
    return false;
  }
  return true;
}

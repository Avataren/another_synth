/**
 * Pure draw ops for the canvas pattern renderer.
 *
 * Each function takes `(ctx, layout, theme, data)`-style arguments and
 * paints exactly what the DOM grid paints for the same inputs: the row
 * striping, entry boxes and text of TrackerEntry.vue/TrackerTrack.vue, the
 * row-number gutter and playback bar of TrackerPattern.vue. All geometry
 * comes from pattern-layout.ts / track-metrics.ts, all colors from
 * pattern-theme.ts (CSS custom properties) or the track data itself
 * (`track.color ?? '#5dd6ff'`, TrackerTrack.vue's fallback accent).
 *
 * The functions never touch `document` or the store; a call-recording
 * CanvasRenderingContext2D mock stands in for the real one in tests.
 */

import {
  columnFractionOffsets,
  entryBoxRect,
  entryHorizontalInsetPx,
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowY,
  type PatternLayout,
} from './pattern-layout';
import { trackGapPx, trackPitchPx, trackWidthPx } from '../track-metrics';
import type { PatternTheme } from './pattern-theme';
import { formatEntryCells, type EntryCells } from './format-entry-cells';
import { activeRowBarWidthPx } from '../pattern-buffering';
import type {
  TrackerEntryData,
  TrackerSelectionRect,
  TrackerTrackData,
} from '../tracker-types';

/** Background class of one row, TrackerEntry.vue's rowType computed. */
export type RowType = 'bar' | 'beat' | 'sub' | 'normal';

/** TrackerEntry's rowType: bar every 16 rows, beat every 4, sub every 2. */
export function rowType(row: number): RowType {
  if (row % 16 === 0) return 'bar';
  if (row % 4 === 0) return 'beat';
  if (row % 2 === 0) return 'sub';
  return 'normal';
}

/** Per-track accent, TrackerTrack.vue: `track.color || '#5dd6ff'`. */
export function trackAccent(track: TrackerTrackData): string {
  return track.color ?? '#5dd6ff';
}

/** Row → interpolation tint map, TrackerTrack.vue's `interpolatedRows`. */
export type InterpolatedRows = Record<number, 'linear' | 'exponential' | undefined>;

export function buildInterpolatedRows(
  track: TrackerTrackData,
): InterpolatedRows {
  const result: InterpolatedRows = {};
  for (const range of track.interpolations ?? []) {
    for (let r = range.startRow; r <= range.endRow; r++) {
      result[r] = range.interpolation ?? 'linear';
    }
  }
  return result;
}

/**
 * Font for cell text: 12px (TrackerEntry's font-size) with the tracker font
 * stack from the theme, bold variants matching the DOM (.note 700,
 * .macro-digit 700, default weight 400).
 */
export function cellFont(theme: PatternTheme, bold = false): string {
  return `${bold ? '700 ' : ''}12px ${theme.fontTracker}`;
}

/** Text drawn with the theme's cell text colors (uppercase like the DOM). */
function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  theme: PatternTheme,
  bold = false,
): void {
  ctx.fillStyle = color;
  ctx.font = cellFont(theme, bold);
  ctx.textBaseline = 'middle';
  ctx.fillText(text.toUpperCase(), x, y);
}

function backgroundFor(
  row: number,
  filled: boolean,
  selected: boolean,
  theme: PatternTheme,
): { bg: string; border: string } {
  if (selected) {
    return { bg: theme.selectedBg, border: theme.selectedBorder };
  }
  // TrackerEntry's CSS cascade: the stripe classes are
  // `.row-*:not(.active):not(.selected)` — higher specificity than
  // `.filled` — so on any non-selected row the stripe background wins and
  // the filled tint only shows through on plain rows, which have no stripe
  // class at all.
  switch (rowType(row)) {
    case 'bar':
      return { bg: theme.rowBar, border: theme.borderBar };
    case 'beat':
      return { bg: theme.rowBeat, border: theme.borderBeat };
    case 'sub':
      return { bg: theme.rowSub, border: theme.borderDefault };
    default:
      return { bg: filled ? theme.entryFilled : theme.entryBase, border: theme.borderDefault };
  }
}

/**
 * Which rows of `track` the selection rect covers — TrackerTrack.vue's
 * `selectedRows` (track range check + row range). Exported for the
 * component's incremental cell repaint, which must apply the same
 * selected-background rule as the full-grid paint.
 */
export function isRowSelected(
  trackIndex: number,
  row: number,
  selection: TrackerSelectionRect | null,
): boolean {
  if (!selection) return false;
  if (
    trackIndex < selection.trackStart ||
    trackIndex > selection.trackEnd ||
    row < selection.rowStart ||
    row > selection.rowEnd
  ) {
    return false;
  }
  return true;
}

/**
 * Paint one entry box: background + border (striping classes, filled vs
 * empty, selected), then the cell text. This is the per-cell repaint unit
 * for incremental edits (§3.3): clip to `entryBoxRect` and call this.
 */
export function drawEntryBox(
  ctx: CanvasRenderingContext2D,
  trackIndex: number,
  row: number,
  layout: PatternLayout,
  theme: PatternTheme,
  track: TrackerTrackData,
  entry: TrackerEntryData | undefined,
  interpolated: 'linear' | 'exponential' | undefined,
  selected: boolean,
): void {
  const box = entryBoxRect(trackIndex, row, layout);
  const filled = entry !== undefined;
  const { bg, border } = backgroundFor(row, filled, selected, theme);

  ctx.fillStyle = bg;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeStyle = border;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  const cells: EntryCells = entry !== undefined
    ? formatEntryCells(entry)
    : // TrackerEntry.vue's DEFAULT_CELLS for empty rows.
      {
        note: { display: '---', className: 'note' },
        instrument: { display: '..', className: 'instrument' },
        volumeHi: { display: '.', className: 'volume volume-high' },
        volumeLo: { display: '.', className: 'volume volume-low' },
        macroDigits: ['.', '.', '.'],
        macro2Digits: ['.', '.', '.'],
      };

  // Cell content box: the fr columns only span inside the entry's
  // `padding: 6px 10px` + 1px border.
  const contentX = box.x + entryHorizontalInsetPx;
  const contentY = box.y + box.height / 2;
  const offsets = columnFractionOffsets(box.width, layout.showExtraEffectColumn);
  const offsetAt = (column: number): number => offsets[column]!;
  const cellLeft = (column: number): number => contentX + offsetAt(column);
  const cellWidth = (column: number): number => offsetAt(column + 1) - offsetAt(column);

  // .note — left-aligned, 700 weight, white.
  drawText(ctx, cells.note.display, cellLeft(0), contentY, theme.noteText, theme, true);
  drawText(ctx, cells.instrument.display, cellLeft(1), contentY, theme.instrumentText, theme);
  // Volume chars share the 0.35fr column (TrackerEntry renders both spans
  // side by side; each is one character wide).
  drawText(ctx, cells.volumeHi.display, cellLeft(2), contentY, theme.volumeText, theme);
  drawText(ctx, cells.volumeLo.display, cellLeft(3), contentY, theme.volumeText, theme);

  // Effect cell: interpolation tint under the digits (TrackerEntry's
  // .interpolated-linear/.interpolated-exponential backgrounds).
  if (interpolated === 'linear') {
    ctx.fillStyle = theme.interpolatedLinear;
    ctx.fillRect(
      box.x + offsetAt(4),
      box.y,
      cellWidth(4),
      box.height,
    );
  } else if (interpolated === 'exponential') {
    ctx.fillStyle = theme.interpolatedExponential;
    ctx.fillRect(
      box.x + offsetAt(4),
      box.y,
      cellWidth(4),
      box.height,
    );
  }

  // Macro nibbles: laid as even thirds of the effect column — the same
  // subdivision hitTest and drawCursorCell use — so the digit under the
  // pointer is the digit the cursor highlights. (Laying them out with the
  // inline-flex gap of the old DOM markup drifted +2px/+4px per digit and
  // split the highlight away from the glyph.)
  const nibbleWidth = cellWidth(4) / 3;
  for (let i = 0; i < cells.macroDigits.length; i++) {
    drawText(
      ctx,
      cells.macroDigits[i]!,
      cellLeft(4) + i * nibbleWidth,
      contentY,
      theme.effectText,
      theme,
      true,
    );
  }

  // Second effect column only exists in dual-effect mode.
  if (layout.showExtraEffectColumn) {
    const nibbleWidth2 = cellWidth(5) / 3;
    for (let i = 0; i < cells.macro2Digits.length; i++) {
      drawText(
        ctx,
        cells.macro2Digits[i]!,
        cellLeft(5) + i * nibbleWidth2,
        contentY,
        theme.effectText,
        theme,
        true,
      );
    }
  }
}

export interface DrawStaticGridData {
  tracks: TrackerTrackData[];
  /** Rows covered by the current clip; defaults to the whole pattern. */
  startRow?: number;
  endRow?: number;
  /** Selection rect to highlight (`in-selection` rows). */
  selection?: TrackerSelectionRect | null;
}

/**
 * The static grid: striping, entry boxes, cell text for every track × row in
 * `[startRow, endRow)`. `clipTo` narrows painting to one track's rect for
 * incremental cell repaints (§3.3).
 */
export function drawStaticGrid(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: DrawStaticGridData,
): void {
  const startRow = Math.max(0, data.startRow ?? 0);
  const endRow = Math.min(layout.rowCount, data.endRow ?? layout.rowCount);
  for (let trackIndex = 0; trackIndex < layout.trackCount; trackIndex++) {
    const track = data.tracks[trackIndex];
    if (!track) continue;
    const lookup = new Map<number, TrackerEntryData>();
    for (const entry of track.entries) lookup.set(entry.row, entry);
    const interpolations = buildInterpolatedRows(track);
    for (let row = startRow; row < endRow; row++) {
      drawEntryBox(
        ctx,
        trackIndex,
        row,
        layout,
        theme,
        track,
        lookup.get(row),
        interpolations[row],
        isRowSelected(trackIndex, row, data.selection ?? null),
      );
    }
  }
}

/**
 * The 78px row-number gutter: hex labels (`00`, `04`, `10` — same
 * `toString(16).toUpperCase().padStart(2, '0')` as TrackerPattern's
 * `formatRow`) in a `.row-number`-styled pill per row, selection highlight
 * included.
 */
export function drawRowNumbers(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: { selection?: TrackerSelectionRect | null; startRow?: number; endRow?: number } = {},
): void {
  const GUTTER_WIDTH = GUTTER_WIDTH_PX;
  const startRow = Math.max(0, data.startRow ?? 0);
  const endRow = Math.min(layout.rowCount, data.endRow ?? layout.rowCount);
  for (let row = startRow; row < endRow; row++) {
    const y = rowY(row);
    const selected =
      data.selection != null && row >= data.selection.rowStart && row <= data.selection.rowEnd;
    ctx.fillStyle = selected ? theme.selectedBg : theme.entryBase;
    ctx.fillRect(0, y, GUTTER_WIDTH, rowHeightPx);
    ctx.strokeStyle = selected ? theme.selectedBorder : theme.borderDefault;
    ctx.strokeRect(0, y, GUTTER_WIDTH, rowHeightPx);
    const label = row.toString(16).toUpperCase().padStart(2, '0');
    ctx.fillStyle = theme.rowNumberText;
    ctx.font = cellFont(theme);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, GUTTER_WIDTH / 2, y + rowHeightPx / 2);
    ctx.textAlign = 'left';
  }
}

export interface DrawSelectionBarData {
  selection: TrackerSelectionRect;
}

/**
 * Selection overlay: one translucent bar per selected row across the
 * selected tracks (the DOM's `.in-selection` highlight, drawn as overlay #2
 * so it never forces a static-grid repaint).
 */
export function drawSelectionBar(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: DrawSelectionBarData,
): void {
  const { rowStart, rowEnd, trackStart, trackEnd } = data.selection;
  for (let row = rowStart; row <= rowEnd; row++) {
    if (row < 0 || row >= layout.rowCount) continue;
    const leftTrack = Math.max(0, Math.min(trackStart, layout.trackCount - 1));
    const rightTrack = Math.max(0, Math.min(trackEnd, layout.trackCount - 1));
    if (rightTrack < leftTrack) continue;
    const x = leftTrack * trackPitchPx(layout.trackCount, layout.showExtraEffectColumn);
    const right =
      (rightTrack + 1) * trackPitchPx(layout.trackCount, layout.showExtraEffectColumn) -
      trackGapPx(layout.trackCount);
    const y = rowY(row);
    ctx.fillStyle = theme.selectedBg;
    ctx.fillRect(x, y, right - x, rowHeightPx);
    ctx.strokeStyle = theme.selectedBorder;
    ctx.strokeRect(x, y, right - x, rowHeightPx);
  }
}

/** Content width of the whole pattern (tracks + gaps), minus trailing gap. */
function totalPatternWidth(layout: PatternLayout): number {
  if (layout.trackCount <= 0) return 0;
  return (
    (layout.trackCount - 1) * trackPitchPx(layout.trackCount, layout.showExtraEffectColumn) +
    trackWidthPx(layout.trackCount, layout.showExtraEffectColumn)
  );
}

export type PlaybackBarMode = 'pattern' | 'song';

export interface DrawActiveRowBarData {
  playbackRow: number;
  mode: PlaybackBarMode;
  /** Track count the bar spans (activeRowBarWidthPx input). */
  trackCount?: number;
  /**
   * Pattern-space x the viewport's left edge sits at (the component's
   * viewLeft). The DOM pins its row-number pill to the page while the tracks
   * scroll horizontally; the overlay is one translated layer, so the gutter
   * segment is placed relative to this to stay at the viewport's left edge.
   * Defaults to 0 (no horizontal scroll).
   */
  gutterScrollX?: number;
}

/** Corner radius of the DOM playback pills (.active-row-bar/.row-playback-bar). */
export const PLAYBACK_BAR_RADIUS_PX = 10;

/**
 * Trace a DOM-style rounded rect (`border-radius` pill) at `radius` px.
 * Uses the native roundRect when the context has one; otherwise the same
 * four arcTo corners, so pre-roundRect browsers still get the pill.
 */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  const r = Math.min(radius, width / 2, height / 2);
  const native = (ctx as unknown as { roundRect?: unknown }).roundRect;
  if (typeof native === 'function') {
    (ctx as unknown as { roundRect: (x: number, y: number, w: number, h: number, r: number) => void }).roundRect(
      x,
      y,
      width,
      height,
      r,
    );
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/**
 * The active-row (playback) indicator, matching the DOM grid's two pills:
 * one across the tracks (`.active-row-bar`, activeRowBarWidthPx wide) and
 * one over the 78px row-number gutter (`.row-playback-bar`), both 10px
 * rounded, rowHeightPx tall, with a 2px mode-colored border over a
 * translucent fill — pattern mode `--tracker-accent-primary` (#4df2c5) on
 * `--tracker-selected-bg`, song mode `--tracker-accent-secondary`
 * (rgb(88, 176, 255)) on rgba(88, 176, 255, 0.14). No gradient or shadow in
 * the DOM styling, so none here either.
 */
export function drawActiveRowBar(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: DrawActiveRowBarData,
): void {
  const borderColor =
    data.mode === 'pattern' ? theme.accentPrimary : theme.accentSecondary;
  const bgColor =
    data.mode === 'pattern' ? theme.selectedBg : 'rgba(88, 176, 255, 0.14)';

  const trackCount = data.trackCount ?? layout.trackCount;
  const barWidth = activeRowBarWidthPx(trackCount, layout.showExtraEffectColumn);
  const width = barWidth ?? totalPatternWidth(layout);
  const y = rowY(data.playbackRow);

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 2;
  // The tracks pill scrolls with the pattern horizontally, exactly like the
  // DOM's .active-row-bar inside the scrolling tracks-wrapper.
  roundRectPath(ctx, 0, y, width, rowHeightPx, PLAYBACK_BAR_RADIUS_PX);
  ctx.fill();
  ctx.stroke();
  // The gutter pill: the DOM's row column never scrolls horizontally, so
  // pin the segment to the viewport's left edge via the current view origin.
  const gutterX = (data.gutterScrollX ?? 0) - GUTTER_WIDTH_PX;
  roundRectPath(ctx, gutterX, y, GUTTER_WIDTH_PX, rowHeightPx, PLAYBACK_BAR_RADIUS_PX);
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1;
}

/**
 * The cursor cell (the focused track/column/nibble of the editing cursor):
 * an `activeBg` fill plus a stroke in the track's own accent, on overlay #2
 * so moving the cursor never repaints the static grid. Column geometry is
 * the same fraction math the hit test uses, so the highlight lands exactly
 * on the cell a click would select; effect-column nibbles subdivide into
 * simple thirds, matching `hitTest`.
 */
export interface CursorCellData {
  trackIndex: number;
  row: number;
  column: number;
  macroNibble: number;
}

export function drawCursorCell(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  tracks: TrackerTrackData[],
  theme: PatternTheme,
  data: CursorCellData,
): void {
  const { trackIndex, row, column, macroNibble } = data;
  if (trackIndex < 0 || trackIndex >= layout.trackCount) return;
  if (row < 0 || row >= layout.rowCount) return;
  const track = tracks[trackIndex];
  if (!track) return;

  const box = entryBoxRect(trackIndex, row, layout);
  const offsets = columnFractionOffsets(box.width, layout.showExtraEffectColumn);
  const col = Math.max(0, Math.min(column, offsets.length - 2));
  let x = box.x + entryHorizontalInsetPx + offsets[col]!;
  let width = offsets[col + 1]! - offsets[col]!;
  if (col === 4 || col === 5) {
    const nibbleWidth = width / 3;
    const nibble = Math.min(2, Math.max(0, macroNibble));
    x += nibble * nibbleWidth;
    width = nibbleWidth;
  }

  ctx.fillStyle = theme.activeBg;
  ctx.fillRect(x, box.y, width, box.height);
  ctx.strokeStyle = trackAccent(track);
  ctx.strokeRect(x, box.y, width, box.height);
}

/** Re-export so draw call sites (and tests) share one import site. */
export { formatEntryCells };
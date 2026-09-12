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
import { EMPTY_CELLS, formatEntryCells, type EntryCells } from './format-entry-cells';
import { activeRowBarWidthPx } from '../pattern-buffering';
import type {
  TrackerEntryData,
  TrackerSelectionRect,
  TrackerTrackData,
} from '../tracker-types';
import { withAlpha } from 'src/utils/color';

/** Background class of one row, TrackerEntry.vue's rowType computed. */
export type RowType = 'bar' | 'beat' | 'sub' | 'normal';

/** TrackerEntry's rowType: bar every 16 rows, beat every 4, sub every 2. */
export function rowType(row: number): RowType {
  if (row % 16 === 0) return 'bar';
  if (row % 4 === 0) return 'beat';
  if (row % 2 === 0) return 'sub';
  return 'normal';
}

/**
 * Per-track accent for track `index`, taken from the theme's ramp (see
 * track-accents.ts) so the track chips and cursor follow the selected theme.
 * The track's own decorative `color` is only a fallback for a themeless call.
 */
export function trackAccent(
  index: number,
  theme: Pick<PatternTheme, 'trackAccents'>,
  track?: TrackerTrackData,
): string {
  const accents = theme.trackAccents;
  return accents[index % accents.length] ?? track?.color ?? '#5dd6ff';
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
 *
 * Memoized on the theme's font stack: a full-grid paint asks for a font
 * twelve times per cell (~20k times for a 26-track pattern), and each ask
 * was building a fresh string.
 */
let fontStackCached = '';
let fontRegularCached = '';
let fontBoldCached = '';

export function cellFont(theme: PatternTheme, bold = false): string {
  if (theme.fontTracker !== fontStackCached) {
    fontStackCached = theme.fontTracker;
    fontRegularCached = `12px ${theme.fontTracker}`;
    fontBoldCached = `700 12px ${theme.fontTracker}`;
  }
  return bold ? fontBoldCached : fontRegularCached;
}

/**
 * The text state written so far in the current run, so identical writes can
 * be skipped. Assigning `ctx.font` costs a font-string parse and a font
 * lookup, and one cell alternates between exactly two fonts while writing
 * twelve strings -- so the same value was being parsed nine times over per
 * cell.
 *
 * A run never spans a save/restore or a second context: every entry point
 * that paints text opens one with `beginTextRun`, and none of them saves,
 * restores or changes context between its own text writes. That is what
 * makes the memo safe to believe -- a stale claim would draw a cell in the
 * wrong weight.
 */
let textFont = '';
let textBaseline: CanvasTextBaseline | '' = '';

/** Open a text run: nothing is known about the context's text state. */
function beginTextRun(): void {
  textFont = '';
  textBaseline = '';
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
  const font = cellFont(theme, bold);
  if (textFont !== font) {
    ctx.font = font;
    textFont = font;
  }
  if (textBaseline !== 'middle') {
    ctx.textBaseline = 'middle';
    textBaseline = 'middle';
  }
  ctx.fillStyle = color;
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
  // The caller may have saved/restored around this cell (the component's
  // per-cell clip does), so nothing is known about the context's text state.
  beginTextRun();

  const box = entryBoxRect(trackIndex, row, layout);
  const filled = entry !== undefined;
  const { bg, border } = backgroundFor(row, filled, selected, theme);

  ctx.fillStyle = bg;
  ctx.fillRect(box.x, box.y, box.width, box.height);
  ctx.strokeStyle = border;
  ctx.strokeRect(box.x, box.y, box.width, box.height);

  // EMPTY_CELLS rather than a literal: empty cells are the common case in
  // real patterns, and the literal allocated six objects and two arrays for
  // every one of them on every full-grid paint.
  const cells: EntryCells = entry !== undefined ? formatEntryCells(entry) : EMPTY_CELLS;

  drawEntryCells(ctx, box, layout, theme, cells, interpolated);
}

/** Options for {@link drawEntryCells}, used by the bright playing-row pre-render. */
interface EntryCellsOpts {
  /**
   * Force the note / instrument / volume glyphs to this colour instead of
   * their per-column theme tokens — the bright playing-row text variant
   * (drawBrightRowText).
   */
  textColor?: string;
  /**
   * Force the effect / macro-digit glyphs to this colour. Separate from
   * {@link textColor} so the playing row's effect cells brighten toward their
   * OWN hue (a brighter `--tracker-effect-text`) rather than collapsing to
   * note-text (MINOR-4). Defaults to {@link textColor} when only that is set,
   * so an all-one-colour caller still works.
   */
  effectTextColor?: string;
  /** Skip the effect-column interpolation tint (text-only overlay pre-render). */
  skipInterpolationTint?: boolean;
  /**
   * Bold the instrument / volume glyphs too, not just note and macro-digit
   * (which are already unconditionally bold, matching `.note`/`.macro-digit`
   * in the DOM). Set only by the playing-row bright pre-render
   * (drawBrightRowText): the DOM makes ALL of a `.row-playing` row's text
   * bold via `.tracker-entry.row-playing .cell`, and instrument/volume are
   * regular weight everywhere else, so this is the canvas mirror of that one
   * rule.
   */
  bold?: boolean;
}

/**
 * The cell content of one entry box: note / instrument / volume / effect
 * text plus the effect-column interpolation tint, laid out inside the box's
 * own rect. Factored out of {@link drawEntryBox} so the bright playing-row
 * pre-render ({@link drawBrightRowText}) places the exact same glyphs, only
 * recoloured — the bright strip must land pixel-aligned on the static text
 * it blits over.
 */
function drawEntryCells(
  ctx: CanvasRenderingContext2D,
  box: { x: number; y: number; width: number; height: number },
  layout: PatternLayout,
  theme: PatternTheme,
  cells: EntryCells,
  interpolated: 'linear' | 'exponential' | undefined,
  opts: EntryCellsOpts = {},
): void {
  const noteColor = opts.textColor ?? theme.noteText;
  const instrumentColor = opts.textColor ?? theme.instrumentText;
  const volumeColor = opts.textColor ?? theme.volumeText;
  const effectColor = opts.effectTextColor ?? opts.textColor ?? theme.effectText;

  // Cell content box: the fr columns only span inside the entry's
  // `padding: 6px 10px` + 1px border.
  const contentX = box.x + entryHorizontalInsetPx;
  const contentY = box.y + box.height / 2;
  const offsets = columnFractionOffsets(box.width, layout.showExtraEffectColumn);
  const offsetAt = (column: number): number => offsets[column]!;
  const cellLeft = (column: number): number => contentX + offsetAt(column);
  const cellWidth = (column: number): number => offsetAt(column + 1) - offsetAt(column);

  // .note — left-aligned, 700 weight, white.
  drawText(ctx, cells.note.display, cellLeft(0), contentY, noteColor, theme, true);
  drawText(ctx, cells.instrument.display, cellLeft(1), contentY, instrumentColor, theme, opts.bold);
  // Volume chars share the 0.35fr column (TrackerEntry renders both spans
  // side by side; each is one character wide).
  drawText(ctx, cells.volumeHi.display, cellLeft(2), contentY, volumeColor, theme, opts.bold);
  drawText(ctx, cells.volumeLo.display, cellLeft(3), contentY, volumeColor, theme, opts.bold);

  // Effect cell: interpolation tint under the digits (TrackerEntry's
  // .interpolated-linear/.interpolated-exponential backgrounds). The bright
  // playing-row overlay skips it — it is background, not text.
  if (!opts.skipInterpolationTint) {
    if (interpolated === 'linear') {
      ctx.fillStyle = theme.interpolatedLinear;
      ctx.fillRect(box.x + offsetAt(4), box.y, cellWidth(4), box.height);
    } else if (interpolated === 'exponential') {
      ctx.fillStyle = theme.interpolatedExponential;
      ctx.fillRect(box.x + offsetAt(4), box.y, cellWidth(4), box.height);
    }
  }

  // Macro nibbles: laid as even thirds of the effect column — the same
  // subdivision hitTest and drawCursorCell use — so the digit under the
  // pointer is the digit the cursor highlights. (Laying them out with the
  // inline-flex gap of the old DOM markup drifted +2px/+4px per digit and
  // split the highlight away from the glyph.)
  const nibbleWidth = cellWidth(4) / 3;
  for (let i = 0; i < cells.macroDigits.length; i++) {
    drawText(ctx, cells.macroDigits[i]!, cellLeft(4) + i * nibbleWidth, contentY, effectColor, theme, true);
  }

  // Second effect column only exists in dual-effect mode.
  if (layout.showExtraEffectColumn) {
    const nibbleWidth2 = cellWidth(5) / 3;
    for (let i = 0; i < cells.macro2Digits.length; i++) {
      drawText(ctx, cells.macro2Digits[i]!, cellLeft(5) + i * nibbleWidth2, contentY, effectColor, theme, true);
    }
  }
}

export interface DrawBrightRowTextData {
  tracks: TrackerTrackData[];
  /** Rows to paint; defaults to the whole pattern. */
  startRow?: number;
  endRow?: number;
  /**
   * Bright colour for the note / instrument / volume glyphs; defaults to the
   * theme note-text token.
   */
  color?: string;
  /**
   * Bright colour for the effect / macro-digit glyphs. Kept separate from
   * {@link color} so the playing row's effect text brightens toward its own
   * hue rather than note-text (MINOR-4). Defaults to the theme's
   * hue-preserving `effectTextBright`.
   */
  effectColor?: string;
}

/**
 * Pre-render the bright playing-row text (task: light up the playing row's
 * TEXT, nothing behind it). Every cell's glyphs for every track × row in
 * range are drawn once onto a transparent surface — no backgrounds, no
 * borders, no interpolation tint. Note/instrument/volume glyphs take the
 * bright note colour; effect/macro glyphs take their own brighter hue
 * (`effectColor`), so the playing row keeps its column colour-coding
 * (MINOR-4) instead of collapsing every glyph to white.
 *
 * Every glyph is also drawn with `drawEntryCells`' `bold` option (note and
 * macro-digit already bold unconditionally; this adds instrument and
 * volume), matching the DOM's `.tracker-entry.row-playing .cell` rule which
 * bolds the whole row. `cellFont(theme, true)` is a distinct cached string
 * from `cellFont(theme, false)` (see cellFont), so the bright/bold glyphs
 * this bakes can never be confused with the regular-weight glyphs
 * {@link drawStaticGrid} paints for every other row onto the separate static
 * bitmap underneath — two different surfaces, two different font strings.
 *
 * The component bakes this into an offscreen bitmap the moment the static
 * grid is (re)built (same lifecycle as the static bitmap: theme, layout,
 * zoom, buffer rebuild) and, per playback tick, blits ONLY the playing
 * row's strip over the indicator overlay — a single drawImage, no per-tick
 * text re-layout, no static-grid repaint, no per-tick font switching (the
 * bold/regular choice is baked in, not decided per blit). Glyph geometry is
 * {@link drawEntryCells}' geometry exactly, so the bright strip lands
 * pixel-aligned over the static text beneath it.
 */
export function drawBrightRowText(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: DrawBrightRowTextData,
): void {
  const color = data.color ?? theme.noteText;
  const effectColor = data.effectColor ?? theme.effectTextBright;
  const startRow = Math.max(0, data.startRow ?? 0);
  const endRow = Math.min(layout.rowCount, data.endRow ?? layout.rowCount);
  for (let trackIndex = 0; trackIndex < layout.trackCount; trackIndex++) {
    const track = data.tracks[trackIndex];
    if (!track) continue;
    const lookup = new Map<number, TrackerEntryData>();
    for (const entry of track.entries) lookup.set(entry.row, entry);
    for (let row = startRow; row < endRow; row++) {
      beginTextRun();
      const box = entryBoxRect(trackIndex, row, layout);
      const entry = lookup.get(row);
      const cells: EntryCells = entry !== undefined ? formatEntryCells(entry) : EMPTY_CELLS;
      drawEntryCells(ctx, box, layout, theme, cells, undefined, {
        textColor: color,
        effectTextColor: effectColor,
        skipInterpolationTint: true,
        bold: true,
      });
    }
  }
}

/**
 * The bright playing-row variant of the row-number gutter: just the hex
 * label glyphs, recoloured, with no pill fill or border. Baked and blitted
 * on the same path as {@link drawBrightRowText}.
 */
export function drawBrightRowNumbers(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  theme: PatternTheme,
  data: { startRow?: number; endRow?: number; color?: string } = {},
): void {
  const color = data.color ?? theme.noteText;
  const startRow = Math.max(0, data.startRow ?? 0);
  const endRow = Math.min(layout.rowCount, data.endRow ?? layout.rowCount);
  beginTextRun();
  // Bold: the DOM mirror is `.row-number.row-playing` (TrackerPattern.vue),
  // and this function only ever paints playing-row gutter digits.
  ctx.font = cellFont(theme, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  for (let row = startRow; row < endRow; row++) {
    const y = rowY(row);
    const label = row.toString(16).toUpperCase().padStart(2, '0');
    ctx.fillText(label, GUTTER_WIDTH_PX / 2, y + rowHeightPx / 2);
  }
  ctx.textAlign = 'left';
  beginTextRun();
}

/**
 * Alpha of each row of the playing-row TEXT trail, nearest row first.
 *
 * The trail is the bright text fading out behind the playhead: row-1 at
 * `[0]`, row-2 at `[1]`, row-3 at `[2]`. The bright glyphs composite over the
 * plain glyphs the static bitmap already painted, so alpha `a` gives exactly
 * `plain * (1 - a) + bright * a` — an interpolation between the renderer's two
 * text states, done by the compositor for the cost of a drawImage (Morten,
 * 2026-09-12: "interpolate between them for say 3 rows").
 *
 * Behind, not ahead: the trail is meant to "match the music", and only rows
 * the playhead has already passed have actually sounded. Lighting the rows
 * below would pre-announce notes that have not played yet.
 */
export const PLAYBACK_TRAIL_ALPHAS = [0.5, 0.28, 0.14] as const;

/** One horizontal run of a trail row to light up, in pattern space. */
export interface TrailSpan {
  x: number;
  width: number;
}

/** Does this entry carry a macro worth lighting (set, and not all dots)? */
function hasEffect(macro: string | undefined): boolean {
  if (!macro) return false;
  const trimmed = macro.trim();
  return trimmed !== '' && !/^\.+$/.test(trimmed);
}

/** Does this entry carry a note event (note, or its instrument/volume)? */
function hasNoteEvent(entry: TrackerEntryData): boolean {
  return (
    (entry.note !== undefined && entry.note.trim() !== '') ||
    (entry.instrument !== undefined && entry.instrument.trim() !== '') ||
    (entry.volume !== undefined && entry.volume.trim() !== '')
  );
}

/**
 * Row → the spans of that row that actually sounded, for the playing-row text
 * trail.
 *
 * Only notes and effects trail (Morten, 2026-09-12: "only active notes and
 * effects brighten up, that would leave a cool trail that somewhat matches the
 * music") — a row's `---` / `...` filler stays plain, so what lingers behind
 * the playhead is the pattern's actual events, not a solid block of text. The
 * note event's instrument and volume ride along with its note span: they are
 * that one event's parameters, not separate glyphs.
 *
 * Built once per static invalidation (same lifecycle as the bright-text bake),
 * never per tick: walking every track's entries on every playback frame is the
 * cost this index exists to avoid. Spans are pattern-space x runs; the caller
 * pairs them with the row's y and blits that rect out of the bright surface.
 */
export function buildTrailSpanIndex(
  layout: PatternLayout,
  tracks: TrackerTrackData[],
): Map<number, TrailSpan[]> {
  const index = new Map<number, TrailSpan[]>();
  const push = (row: number, span: TrailSpan): void => {
    const spans = index.get(row);
    if (spans) spans.push(span);
    else index.set(row, [span]);
  };
  for (let trackIndex = 0; trackIndex < layout.trackCount; trackIndex++) {
    const track = tracks[trackIndex];
    if (!track) continue;
    const box = entryBoxRect(trackIndex, 0, layout);
    const offsets = columnFractionOffsets(box.width, layout.showExtraEffectColumn);
    const contentX = box.x + entryHorizontalInsetPx;
    const at = (column: number): number => offsets[column]!;
    for (const entry of track.entries) {
      if (entry.row < 0 || entry.row >= layout.rowCount) continue;
      if (hasNoteEvent(entry)) {
        // Columns 0-3: note, instrument, both volume digits.
        push(entry.row, { x: contentX + at(0), width: at(4) - at(0) });
      }
      if (hasEffect(entry.macro)) {
        push(entry.row, { x: contentX + at(4), width: at(5) - at(4) });
      }
      if (layout.showExtraEffectColumn && hasEffect(entry.macro2)) {
        push(entry.row, { x: contentX + at(5), width: at(6) - at(5) });
      }
    }
  }
  return index;
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
  // The gutter writes one font and one alignment for the whole run rather
  // than re-stating them per row, and tells the cell text memo that it did.
  beginTextRun();
  ctx.font = cellFont(theme);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
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
    ctx.fillText(label, GUTTER_WIDTH / 2, y + rowHeightPx / 2);
  }
  ctx.textAlign = 'left';
  // Written outside the memo's knowledge, so it no longer describes the
  // context.
  beginTextRun();
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
}

/** Corner radius of the DOM playback pills (.active-row-bar/.row-playback-bar). */
export const PLAYBACK_BAR_RADIUS_PX = 10;

/**
 * Border width of the DOM playback pills (.active-row-bar/.row-playback-bar).
 * Bumped from 2px (Morten, 2026-09-11: "barely visible, make it pop more").
 */
export const PLAYBACK_BAR_BORDER_PX = 3;

/**
 * Fill alpha of the DOM playback pills' translucent tint (0.14 → 0.28 → this).
 * Mixed with the mode's own accent color — not a flat constant color — so the
 * fill always matches the border's hue on every built-in theme. Static; no
 * glow, no animation (Morten reverted the v0.3.35 row-glow in 3 minutes), so
 * "pop more" is spent on the pill's own contrast, plus the text trail behind
 * it (PLAYBACK_TRAIL_ALPHAS) which leaves the playing row the only fully-lit
 * row on screen.
 */
export const PLAYBACK_BAR_FILL_ALPHA = 0.34;

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
 * rounded, rowHeightPx tall, with a `PLAYBACK_BAR_BORDER_PX` mode-colored
 * border over a translucent fill at `PLAYBACK_BAR_FILL_ALPHA` of that same
 * color — pattern mode `--tracker-accent-primary` (#4df2c5), song mode
 * `--tracker-accent-secondary` (rgb(88, 176, 255)). No gradient or shadow in
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
  const bgColor = withAlpha(borderColor, PLAYBACK_BAR_FILL_ALPHA);

  const trackCount = data.trackCount ?? layout.trackCount;
  const barWidth = activeRowBarWidthPx(trackCount, layout.showExtraEffectColumn);
  const width = barWidth ?? totalPatternWidth(layout);
  const y = rowY(data.playbackRow);

  ctx.fillStyle = bgColor;
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = PLAYBACK_BAR_BORDER_PX;
  // The tracks pill scrolls with the pattern horizontally, exactly like the
  // DOM's .active-row-bar inside the scrolling tracks-wrapper.
  roundRectPath(ctx, 0, y, width, rowHeightPx, PLAYBACK_BAR_RADIUS_PX);
  ctx.fill();
  ctx.stroke();
  // The gutter pill scrolls with the pattern too, drawn at the row-number
  // column's own pattern-space rect [-GUTTER_WIDTH_PX, 0) so it stays on the
  // labels the static bitmap paints there. The DOM grid is the spec, and it
  // scrolls its row column with the tracks on exactly the surface where this
  // renderer is most used (TrackerPattern.vue's ≤900px media query turns
  // .row-column into an overflow-x:auto strip), so the pill must pan away
  // with them — pinning it to the viewport edge parked it over track content
  // the gutter had already scrolled past (Morten, 2026-09-04: the indicator
  // "clings to the left side of screen" while panning right). Edge-adjacent
  // to the tracks pill at pattern x 0, the same adjacency the DOM's two grid
  // columns paint, so the pills can never overlap at any scroll origin.
  roundRectPath(ctx, -GUTTER_WIDTH_PX, y, GUTTER_WIDTH_PX, rowHeightPx, PLAYBACK_BAR_RADIUS_PX);
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

/**
 * The cursor cell's pattern-space rect — the same geometry `drawCursorCell`
 * paints, factored out so the component can compute the overlay band the
 * cell occupies without re-deriving the fraction math (a divergence here
 * would clear a band the highlight is not actually in).
 */
export function cursorCellRect(
  layout: PatternLayout,
  tracks: TrackerTrackData[],
  data: CursorCellData,
): { x: number; y: number; width: number; height: number } | null {
  const { trackIndex, row, column, macroNibble } = data;
  if (trackIndex < 0 || trackIndex >= layout.trackCount) return null;
  if (row < 0 || row >= layout.rowCount) return null;
  const track = tracks[trackIndex];
  if (!track) return null;

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
  return { x, y: box.y, width, height: box.height };
}

export function drawCursorCell(
  ctx: CanvasRenderingContext2D,
  layout: PatternLayout,
  tracks: TrackerTrackData[],
  theme: PatternTheme,
  data: CursorCellData,
): void {
  const rect = cursorCellRect(layout, tracks, data);
  if (!rect) return;
  const track = tracks[data.trackIndex]!;

  ctx.fillStyle = theme.activeBg;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = trackAccent(data.trackIndex, theme, track);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
}

/** Re-export so draw call sites (and tests) share one import site. */
export { formatEntryCells };
<template>
  <div
    class="pattern-canvas"
    :style="{ '--tracker-side-gutter': sideGutter, '--panel-width': `${panelWidth}px` }"
  >
    <!--
      Sticky header strip: track chips aligned over the bitmap's track
      columns (the same geometry the blit uses), shifted against horizontal
      scroll so a column keeps its chip. The leading slot matches the 78px
      row-number gutter the bitmap paints.
    -->
    <div class="canvas-header" aria-hidden="true">
      <div class="canvas-header-inner" :style="headerShift">
        <div class="header-row-label">Row</div>
        <div
          v-for="(track, index) in tracks"
          :key="track.id"
          class="header-track"
          :style="headerTrackStyle(index)"
        >
          <span class="header-track-index">{{ index + 1 }}</span>
          <span class="header-track-name">{{ track.name }}</span>
        </div>
      </div>
    </div>

    <!--
      Native vertical scroller: the spacer (absolutely positioned) makes the
      pattern's full height scrollable; the viewport canvas stack is sticky,
      so it stays pinned while the spacer scrolls beneath it. scrollTop of
      this element is the pattern-space y of the bitmap's top line.
    -->
    <div ref="scrollerRef" class="canvas-scroller" @scroll="onScrollerScroll">
      <div ref="viewportRef" class="canvas-viewport">
        <canvas ref="visibleCanvasRef" class="canvas-layer"></canvas>
        <canvas
          ref="overlayCanvasRef"
          class="canvas-layer"
          @mousedown="onCanvasMouseDown"
          @touchstart="onTouchStart"
          @touchmove="onTouchMove"
          @touchend="onTouchEnd"
          @touchcancel="onTouchCancel"
        ></canvas>
      </div>
      <div
        class="canvas-spacer"
        :style="{ width: `${contentWidth}px`, height: `${totalRowsHeight}px` }"
      ></div>
    </div>

    <!--
      Horizontal proxy scrollbar: the scroller clips horizontally, so the
      extent mirrors the bitmap's full width and its scrollLeft is the
      blit's horizontal origin.
    -->
    <div v-show="hscrollVisible" ref="hscrollRef" class="canvas-hscroll" @scroll="onHScroll">
      <div class="canvas-hscroll-extent" :style="{ width: `${contentWidth}px` }"></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  buildEntryLookup,
  entryBoxRect,
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowPitchPx,
  rowY,
  patternPanelWidth,
  reservedSideGutterPx,
  totalTracksWidth,
  type PatternLayout,
} from './pattern-layout';
import { hitTest, type PatternHit } from './pattern-hit-test';
import { blitWindow, snapToDevicePx } from './pattern-window';
import {
  bitmapScaleFor,
  DESKTOP_BITMAP_BUDGET,
  MOBILE_BITMAP_BUDGET,
} from './pattern-bitmap';
import { useMobileLayout } from 'src/composables/useMobileLayout';
import {
  flingVelocity,
  isTap,
  panTarget,
  FLING_DECAY,
  FLING_STOP_VELOCITY,
  type FlingSample,
  type TouchPanOrigin,
} from './pattern-touch';
import {
  drawActiveRowBar,
  buildInterpolatedRows,
  buildTrailSpanIndex,
  cursorCellRect,
  PLAYBACK_TRAIL_ALPHAS,
  type TrailSpan,
  drawBrightRowNumbers,
  drawBrightRowText,
  drawCursorCell,
  drawEntryBox,
  drawRowNumbers,
  drawSelectionBar,
  drawStaticGrid,
  isRowSelected,
  trackAccent,
  type InterpolatedRows,
  type PlaybackBarMode,
} from './pattern-draw';
import {
  overlayClearBands,
  type OverlayFootprint,
} from './pattern-bands';
import { getTheme, refresh as refreshTheme, type PatternTheme } from './pattern-theme';
import {
  buildPaintState,
  diffPaintState,
  type CellDiff,
  type PaintState,
} from './pattern-diff';
import {
  canAdoptPreRender,
  metaFromInfo,
  paintUpcoming,
  preRenderExtent,
  type PreRenderMeta,
} from './pattern-prerender';
import { trackPitchPx, trackWidthPx } from '../track-metrics';
import type { UpcomingPatternInfo } from '../pattern-buffering';
import type {
  TrackerEntryData,
  TrackerSelectionRect,
  TrackerTrackData,
} from '../tracker-types';

interface Props {
  tracks: TrackerTrackData[];
  rows: number;
  selectedRow: number;
  playbackRow: number;
  activeTrack: number;
  activeColumn: number;
  autoScroll: boolean;
  isPlaying: boolean;
  playbackMode: 'pattern' | 'song';
  activeMacroNibble: number;
  selectionRect: TrackerSelectionRect | null;
  scrollTop: number;
  scrollLeft?: number;
  containerWidth?: number;
  containerHeight: number;
  isMouseSelecting: boolean;
  showExtraEffectColumn: boolean;
  /** Whether the spectrum analyser is on and needs gutters to draw in. */
  reserveSideGutter: boolean;
  /**
   * When true (default), playback follow advances exactly one row pitch per
   * step (the DOM grid's behavior). When false, the view only re-anchors
   * once the playing row leaves a margin window — coarser paging that some
   * users prefer on long patterns.
   */
  granularScroll?: boolean;
  /**
   * Reserved for the editing cursor's keyboard wiring: pointer selection and
   * cell events emit regardless, exactly as the DOM grid does, so the page's
   * own edit-mode handlers stay the single gate.
   */
  enableEditing?: boolean;
  /**
   * The pattern coming next, per selectUpcomingPattern's guard rules. While
   * it is set, it is pre-rendered into a second offscreen bitmap off the
   * critical path; a playback swap adopts that bitmap with a pointer swap
   * (one blit, no full repaint). An adoption check by content identity falls
   * back to the regular static paint when the pre-render is stale or absent.
   */
  upcomingPattern?: { id: string; tracks: TrackerTrackData[]; rows: number } | null;
}

const props = withDefaults(defineProps<Props>(), {
  scrollLeft: 0,
  containerWidth: 0,
  enableEditing: false,
  upcomingPattern: null,
  granularScroll: true,
});

const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number; macroNibble?: number }): void;
  (event: 'startSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'hoverSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'scroll', payload: { top: number; left: number }): void;
  (event: 'rendererError', error: Error): void;
}>();

const scrollerRef = ref<HTMLDivElement | null>(null);
const hscrollRef = ref<HTMLDivElement | null>(null);
const viewportRef = ref<HTMLDivElement | null>(null);
const visibleCanvasRef = ref<HTMLCanvasElement | null>(null);
const overlayCanvasRef = ref<HTMLCanvasElement | null>(null);

/** View origin in pattern space; the props are the external source of truth. */
const viewTop = ref(props.scrollTop);
const viewLeft = ref(props.scrollLeft);
/** Measured scroller size; the container props only seed the first frame. */
const viewportW = ref(Math.max(0, props.containerWidth));
const viewportH = ref(Math.max(0, props.containerHeight));
const dpr = ref(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

/**
 * How much bitmap this device will allocate. A desktop gets what the
 * renderer always took; a phone, where the allocation actually fails, gets
 * a budget it can hold (see pattern-bitmap).
 */
const isMobileDevice = useMobileLayout();
const bitmapBudget = computed(() =>
  isMobileDevice.value ? MOBILE_BITMAP_BUDGET : DESKTOP_BITMAP_BUDGET,
);

const layout = computed<PatternLayout>(() => ({
  trackCount: props.tracks.length,
  showExtraEffectColumn: props.showExtraEffectColumn,
  rowCount: props.rows,
}));

/** Full bitmap extent in CSS pixels: gutter + every track column. */
const contentWidth = computed(
  () => GUTTER_WIDTH_PX + totalTracksWidth(props.tracks.length, props.showExtraEffectColumn),
);
const totalRowsHeight = computed(() => Math.max(0, props.rows) * rowPitchPx);

/**
 * The canvas panel's own width. The DOM grid is `inline-flex`, so it is only
 * as wide as its tracks and centers in the page; a block canvas would fill
 * the row and leave the spectrum analyser nowhere to draw. Match the DOM:
 * the panel is the bitmap's content width plus its own padding and border,
 * centered by `margin-inline: auto`; the stylesheet's max-width cap (the
 * same one the DOM grid uses) clamps it when the pattern is wider than the
 * viewport, and the scroller scrolls the overflow.
 */
const panelWidth = computed(() => patternPanelWidth(contentWidth.value));

/** .pattern-area's own 18px side padding; containerWidth is its padding box. */
const PAGE_PADDING_X_PX = 36;

/** Space available to the panel inside the page's pattern area. */
const availableWidth = computed(() => Math.max(0, props.containerWidth - PAGE_PADDING_X_PX));

/** The analyser gutter the stylesheet holds back on each side of the panel. */
const reservedGutterPx = computed(() =>
  reservedSideGutterPx(
    props.reserveSideGutter,
    props.tracks.length,
    props.showExtraEffectColumn,
    availableWidth.value,
  ),
);

/** The cap the stylesheet's max-width applies to the panel. */
const panelMaxWidth = computed(() =>
  Math.max(0, availableWidth.value - 2 * reservedGutterPx.value),
);

const sideGutter = computed(() =>
  props.reserveSideGutter
    ? `${trackWidthPx(props.tracks.length, props.showExtraEffectColumn)}px`
    : '0px',
);

/**
 * The proxy scrollbar is needed exactly when the panel is width-capped:
 * shrunk-to-fit, the scroller is exactly as wide as the content, so the
 * old content-vs-viewport comparison would never fire; only the cap can
 * clip tracks, and then the scroller hides the overflow for the proxy.
 */
const hscrollVisible = computed(() => panelWidth.value > panelMaxWidth.value);

/*
 * The header chips ride the same horizontal origin as the blit, snapped to
 * the same device pixel: an unsnapped translate re-rasterizes the chip text
 * at a different sub-pixel phase than the track columns it labels.
 */
const headerShift = computed(() => ({
  transform: `translateX(${-snapToDevicePx(viewLeft.value, dpr.value)}px)`,
}));

/**
 * Bumped on every theme flip so the header chips (plain DOM, outside the
 * canvas paint path) re-read the palette the observer just refreshed.
 */
const themeRevision = ref(0);

/** The theme's per-track accent ramp, re-read whenever the theme changes. */
const trackAccents = computed(() => {
  void themeRevision.value;
  return getTheme().trackAccents;
});

function headerTrackStyle(index: number) {
  return {
    left: `${GUTTER_WIDTH_PX + index * trackPitchPx(layout.value.trackCount, layout.value.showExtraEffectColumn)}px`,
    width: `${trackWidthPx(layout.value.trackCount, layout.value.showExtraEffectColumn)}px`,
    '--track-accent': trackAccent(index, { trackAccents: trackAccents.value }),
  };
}

// ---------------------------------------------------------------------
// Renderer error path
// ---------------------------------------------------------------------

let rendererFailed = false;
function failRenderer(message: string): boolean {
  if (!rendererFailed) {
    rendererFailed = true;
    emit('rendererError', new Error(message));
  }
  return false;
}

// ---------------------------------------------------------------------
// Offscreen full-pattern bitmap
// ---------------------------------------------------------------------

type BitmapSurface = OffscreenCanvas | HTMLCanvasElement;
let bitmap: BitmapSurface | null = null;
let bitmapKey = '';
/** CSS extent the bitmap was built for; -1 until the first paint. */
let bitmapCssWidth = -1;
let bitmapCssHeight = -1;
/**
 * Content the static bitmap currently shows (per-track entry references,
 * layout, selection). The edit watcher diffs the next tracks prop against
 * this to repair changed cells instead of repainting the whole bitmap.
 */
let paintedState: PaintState | null = null;
/** Device-pixel scale the static bitmap was last built at. */
let bitmapDpr = 1;

/**
 * Bright playing-row TEXT pre-render (task: light up the playing row's text,
 * nothing behind it). A second offscreen surface, the exact size and scale
 * of the static bitmap, holding every cell's glyphs once in a theme-derived
 * bright colour on a transparent background — no fills, no borders, no bar.
 * Baked lazily the first time a playback frame needs it and reused until the
 * static bitmap's own lifecycle invalidates it (theme / layout / zoom /
 * buffer rebuild / cell edit). Per playback tick the overlay blits ONLY the
 * playing row's strip from it — one drawImage, no text re-layout, no
 * static-grid repaint (§3.3 layering: this is overlay-side work).
 */
/** The allocation, reused across re-bakes (sized like the static bitmap). */
let brightRowTextSurface: BitmapSurface | null = null;
/**
 * What the overlay is allowed to blit: `brightRowTextSurface` once a bake has
 * populated it, `null` whenever the bake is stale (invalidated, deferred and
 * not yet re-run, or refused for budget/allocation reasons). The overlay
 * blit already no-ops on `null`, so a `null` here means the playing row shows
 * plain (un-brightened) text from the static bitmap — correct, never wrong
 * colours.
 */
let brightRowTextBitmap: BitmapSurface | null = null;
let brightRowTextValid = false;
/** Handle of a pending off-critical-path re-bake (idle callback or rAF). */
let brightRowTextRebakeId: number | null = null;
let brightRowTextRebakeIsIdle = false;
/**
 * Row → the spans of that row that carry a note or an effect, for the text
 * trail behind the playhead (buildTrailSpanIndex). Shares the bright surface's
 * lifecycle — same content, same invalidations — but is independent of whether
 * the surface itself could be allocated, so it is built on its own and stays
 * cheap: a plain index over the entries, no pixels.
 */
let trailSpanIndex: Map<number, TrailSpan[]> | null = null;

/**
 * Drop the bright playing-row text pre-render synchronously; the next
 * playback overlay frame re-bakes it inline. Used for the paths that already
 * pay for a full static repaint (paintStatic, theme flip, resize) — the bake
 * rides along with work that frame is doing anyway, and the FIRST bake of a
 * playback session is meant to be synchronous (approved behaviour).
 */
function invalidateBrightRowText(): void {
  brightRowTextValid = false;
  brightRowTextBitmap = null;
  trailSpanIndex = null;
}

/**
 * Invalidate and re-bake OFF the critical path (MAJOR-2). The fast static
 * paths — incremental cell repair and the ping-pong adoption swap — run
 * inside a playback-critical frame, and a synchronous full-pattern bright-text
 * bake there is a visible hitch on large patterns. Instead: drop the surface
 * now (so the overlay blits nothing and the row falls back to plain static
 * text — correct-ish, never wrong colours) and schedule the bake off this
 * frame, mirroring schedulePreRender.
 *
 * Scheduling contract: idle-first (`requestIdleCallback`), rAF fallback. Under
 * continuous playback the main thread may never truly idle, so the idle
 * request carries `{ timeout: 150 }` — the re-bake runs at the next idle slot
 * or within ~150 ms, whichever comes first, never starving indefinitely. The
 * `run` callback swallows any throw from the bake (F4): a failed re-bake
 * degrades to plain text, it must not escape the idle/rAF callback.
 */
function scheduleBrightRowTextRebake(): void {
  brightRowTextValid = false;
  brightRowTextBitmap = null;
  trailSpanIndex = null;
  // Nothing to defer while stopped: the next playback start bakes fresh.
  if (!props.isPlaying) return;
  // A second invalidation before the callback fires must not double-schedule.
  if (brightRowTextRebakeId !== null) return;
  const w = window as unknown as IdleWindow;
  const run = () => {
    brightRowTextRebakeId = null;
    // bakeBrightRowText is self-degrading (F4): any throw inside it — from the
    // allocation or the draw phase — is swallowed and leaves plain text, so
    // this callback never throws out of the idle/rAF slot.
    bakeBrightRowText();
    // Show the freshly baked strip (or plain text on failure): the frame that
    // invalidated painted the row plain.
    schedule(['overlay']);
  };
  if (typeof w.requestIdleCallback === 'function') {
    brightRowTextRebakeIsIdle = true;
    brightRowTextRebakeId = w.requestIdleCallback(run, { timeout: 150 });
  } else {
    brightRowTextRebakeIsIdle = false;
    brightRowTextRebakeId = requestAnimationFrame(run);
  }
}

/** Cancel a pending deferred bright-text re-bake (unmount). */
function cancelBrightRowTextRebake(): void {
  if (brightRowTextRebakeId === null) return;
  const w = window as unknown as IdleWindow;
  if (brightRowTextRebakeIsIdle && typeof w.cancelIdleCallback === 'function') {
    w.cancelIdleCallback(brightRowTextRebakeId);
  } else {
    cancelAnimationFrame(brightRowTextRebakeId);
  }
  brightRowTextRebakeId = null;
}

/**
 * Build (or reuse) the full-pattern bitmap, at the best scale it fits at.
 *
 * `scale` is what the screen would like -- its device pixel ratio. A
 * pattern too big to paint at that (a 26-channel module on a 3x phone is
 * 91M device pixels) is painted at a lower one and stretched by the blit
 * rather than refused; see pattern-bitmap for why that beats both giving up
 * and tiling. Null means even the floor will not fit, and the caller falls
 * back to the DOM grid.
 */
function ensureBitmap(cssW: number, cssH: number, scale: number): BitmapSurface | null {
  const fitted = bitmapScaleFor(cssW, cssH, scale, bitmapBudget.value);
  if (fitted === null) return null;
  const w = Math.max(1, Math.ceil(cssW * fitted));
  const h = Math.max(1, Math.ceil(cssH * fitted));
  const key = `${w}x${h}`;
  if (bitmap && bitmapKey === key) return bitmap;
  let next: BitmapSurface;
  if (typeof OffscreenCanvas !== 'undefined') {
    next = new OffscreenCanvas(w, h);
  } else {
    next = document.createElement('canvas');
  }
  next.width = w;
  next.height = h;
  bitmap = next;
  bitmapKey = key;
  bitmapDpr = fitted;
  bitmapCssWidth = cssW;
  bitmapCssHeight = cssH;
  return next;
}

/**
 * Paint one changed cell of the static bitmap: clip to the entry box, clear
 * and repaint it (§3.3). Everything outside the clip is untouched, so the
 * rest of the bitmap stays valid for the blit.
 *
 * The context, theme and the track's row lookups come from the caller: they
 * are per-track work, and rebuilding them per cell made a multi-cell repair
 * (a paste, a multi-row delete) re-scan the whole track once for every row
 * it touched.
 */
function repaintCell(
  ctx: CanvasRenderingContext2D,
  theme: PatternTheme,
  trackIndex: number,
  row: number,
  track: TrackerTrackData,
  lookup: Map<number, TrackerEntryData>,
  interpolations: InterpolatedRows,
): void {
  const l = layout.value;
  const box = entryBoxRect(trackIndex, row, l);
  // Repair canvas-space rect, widened by a bitmap pixel per side so no
  // anti-aliased edge of the neighboring paint bleeds through the clip.
  // Snapped in the bitmap's own scale, which is not the screen's when the
  // pattern was too big to paint at full resolution.
  const d = bitmapDpr;
  const cssX = (Math.floor((box.x + GUTTER_WIDTH_PX) * d) - 1) / d;
  const cssY = (Math.floor(box.y * d) - 1) / d;
  const cssW = (Math.ceil(box.width * d) + 2) / d;
  const cssH = (Math.ceil(box.height * d) + 2) / d;

  // Same CSS-space transform paintStatic uses (dpr-mapped pattern space),
  // clipped to the one cell; the draw op then runs in paintStatic's exact
  // coordinate frame (gutter-translated pattern space).
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cssX, cssY, cssW, cssH);
  ctx.clip();
  ctx.clearRect(cssX, cssY, cssW, cssH);
  ctx.translate(GUTTER_WIDTH_PX, 0);
  drawEntryBox(
    ctx,
    trackIndex,
    row,
    l,
    theme,
    track,
    lookup.get(row),
    interpolations[row],
    isRowSelected(trackIndex, row, props.selectionRect),
  );
  ctx.restore();
}

/**
 * Apply a cell diff to the static bitmap (clip + repaint per changed cell)
 * and refresh the paint bookkeeping to the new content. Returns false when
 * there is no bitmap to repair — the caller falls back to a full paint.
 */
function repaintCells(diffs: CellDiff[]): boolean {
  const surface = bitmap;
  if (!surface) return false;
  const rawCtx = surface.getContext('2d');
  if (!rawCtx) return false;
  const ctx = rawCtx as unknown as CanvasRenderingContext2D;
  const theme = getTheme();
  for (const diff of diffs) {
    const track = props.tracks[diff.trackIndex];
    if (!track) continue;
    const lookup = buildEntryLookup(track);
    const interpolations = buildInterpolatedRows(track);
    for (const row of diff.rows) {
      repaintCell(ctx, theme, diff.trackIndex, row, track, lookup, interpolations);
    }
  }
  paintedState = buildPaintState(
    props.tracks,
    props.rows,
    props.showExtraEffectColumn,
    props.selectionRect,
  );
  // A repaired cell may have changed its glyphs; rebake the bright variant —
  // but OFF the critical playback frame (MAJOR-2). Until the deferred bake
  // lands the playing row shows plain static text.
  scheduleBrightRowTextRebake();
  return true;
}

/**
 * Paint the whole pattern into the offscreen bitmap: row-number gutter,
 * then the track grid and selection overlay shifted past it. Repainted on
 * track-array identity, pattern size, selection and theme changes — never
 * per playback row (the overlay owns that). Cell-level entry edits take the
 * incremental path (repaintCells) instead of this full paint.
 */
function paintStatic(): boolean {
  const cssW = contentWidth.value;
  const cssH = totalRowsHeight.value;
  if (cssW <= 0 || cssH <= 0) return true;
  const surface = ensureBitmap(cssW, cssH, dpr.value);
  if (!surface)
    return failRenderer(
      'pattern-canvas: pattern bitmap exceeds the device-pixel cap — falling back to the DOM grid',
    );
  const rawCtx = surface.getContext('2d');
  if (!rawCtx) return failRenderer('pattern-canvas: offscreen 2D context unavailable');
  // The draw ops are 2D-context calls only, so the offscreen flavor is
  // runtime-compatible; narrowed here once for their signatures.
  const ctx = rawCtx as unknown as CanvasRenderingContext2D;
  const theme = getTheme();
  const l = layout.value;
  // bitmapDpr, not dpr: ensureBitmap may have come down a scale to fit.
  ctx.setTransform(bitmapDpr, 0, 0, bitmapDpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = theme.panelBackground;
  ctx.fillRect(0, 0, cssW, cssH);
  drawRowNumbers(ctx, l, theme, { selection: props.selectionRect });
  ctx.save();
  ctx.translate(GUTTER_WIDTH_PX, 0);
  drawStaticGrid(ctx, l, theme, { tracks: props.tracks, selection: props.selectionRect });
  if (props.selectionRect) {
    drawSelectionBar(ctx, l, theme, { selection: props.selectionRect });
  }
  ctx.restore();
  paintedState = buildPaintState(
    props.tracks,
    props.rows,
    props.showExtraEffectColumn,
    props.selectionRect,
  );
  // The bright playing-row text is baked from this same content/theme, so a
  // full static repaint invalidates it.
  invalidateBrightRowText();
  return true;
}

/**
 * Bake the bright playing-row text pre-render into an offscreen surface the
 * size and scale of the current static bitmap. Runs at most once per static
 * invalidation (never per playback tick). No-op without a static bitmap.
 *
 * Degraded paths (MAJOR-1): a phone during song playback can be holding the
 * static bitmap, the ping-pong pre-render AND this surface at once. If this
 * surface would push past the device's bitmap budget, or its allocation
 * throws (iOS caps canvas memory hard), the bright-text effect is SKIPPED —
 * `brightRowTextBitmap` stays `null`, the overlay blit no-ops, the playing
 * row shows plain static text. An allocation throw must never escape into
 * `runFrame` and wedge the rAF loop, so `new OffscreenCanvas` is wrapped
 * exactly like `paintPreRender`'s, with the element fallback and a final
 * give-up. `brightRowTextValid` is set true on the degraded path too, so a
 * refused bake is not retried every tick — an invalidation re-arms it.
 *
 * F4: the outer `bakeBrightRowText` wraps this whole body — allocation AND
 * the setTransform/clearRect/drawBright* draw phase — so ANY throw degrades to
 * plain text and never escapes into `paintOverlay`→`runFrame` (no try/catch
 * there) or the deferred idle callback.
 */
function bakeBrightRowTextInner(): void {
  const source = bitmap;
  if (!source) {
    brightRowTextBitmap = null;
    return;
  }
  const w = source.width;
  const h = source.height;
  // Budget gate, mirroring ensureBitmap's `bitmapScaleFor` guard: refuse when
  // this surface alone would exceed what the device will hold. The static
  // bitmap passed the same budget at build time, but the budget is reactive
  // (useMobileLayout) and can tighten to the mobile ceiling under a
  // desktop-sized bitmap without a rebuild.
  const budget = bitmapBudget.value;
  if (w * h > budget.maxArea || w > budget.maxDimension || h > budget.maxDimension) {
    brightRowTextBitmap = null;
    brightRowTextValid = true;
    return;
  }
  let surface = brightRowTextSurface;
  if (!surface || surface.width !== w || surface.height !== h) {
    surface = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        surface = new OffscreenCanvas(w, h);
      } catch {
        surface = null;
      }
    }
    if (!surface) {
      try {
        const el = document.createElement('canvas');
        el.width = w;
        el.height = h;
        surface = el;
      } catch {
        surface = null;
      }
    }
    if (!surface) {
      // Both allocation paths failed: skip the effect, keep playback running.
      brightRowTextSurface = null;
      brightRowTextBitmap = null;
      brightRowTextValid = true;
      return;
    }
    brightRowTextSurface = surface;
  }
  const rawCtx = surface.getContext('2d');
  if (!rawCtx) {
    brightRowTextBitmap = null;
    brightRowTextValid = true;
    return;
  }
  const ctx = rawCtx as unknown as CanvasRenderingContext2D;
  const theme = getTheme();
  const l = layout.value;
  ctx.setTransform(bitmapDpr, 0, 0, bitmapDpr, 0, 0);
  ctx.clearRect(0, 0, bitmapCssWidth, bitmapCssHeight);
  // Note/instrument/volume glyphs brighten toward the theme's note-text token
  // (matching TrackerEntry's `.row-playing .cell` rule); effect/macro glyphs
  // brighten toward their own hue-preserving bright variant (MINOR-4) — the
  // same `--tracker-effect-text-bright` the DOM path reads.
  const color = theme.noteText;
  const effectColor = theme.effectTextBright;
  drawBrightRowNumbers(ctx, l, theme, { color });
  ctx.save();
  ctx.translate(GUTTER_WIDTH_PX, 0);
  drawBrightRowText(ctx, l, theme, { tracks: props.tracks, color, effectColor });
  ctx.restore();
  brightRowTextBitmap = surface;
  brightRowTextValid = true;
}

/**
 * F4 wrapper: degrade the whole bright-text bake to plain text on ANY throw —
 * a context/draw-phase failure (context stub that throws, an exhausted GPU)
 * must not propagate out of `paintOverlay`→`runFrame` or the deferred idle
 * callback and wedge playback. On failure: no bright bitmap, marked valid so
 * it is not retried every tick (an invalidation re-arms it), no rethrow.
 */
function bakeBrightRowText(): void {
  try {
    bakeBrightRowTextInner();
  } catch {
    brightRowTextBitmap = null;
    brightRowTextValid = true;
  }
}

/**
 * Ensure a fresh bright-text surface is available for the overlay blit.
 * Called inside the playback overlay paint. The FIRST bake of a playback
 * session is synchronous (approved: bake-once when playback starts); an
 * invalidation that scheduled a DEFERRED re-bake leaves `brightRowTextBitmap`
 * null until the idle callback runs, so this frame's row shows plain text
 * rather than a stale (wrong-content) strip.
 */
function ensureBrightRowText(): void {
  if (brightRowTextValid) return;
  if (brightRowTextRebakeId !== null) return; // deferred re-bake pending
  bakeBrightRowText();
}

// ---------------------------------------------------------------------
// Upcoming-pattern pre-render (§3.2): ping-pong bitmap swap
// ---------------------------------------------------------------------

/** The second bitmap of the ping-pong pair, painted off the critical path. */
let preRenderBitmap: BitmapSurface | null = null;
/** Content the pre-render bitmap holds (or is being painted to hold). */
let preRenderMeta: PreRenderMeta | null = null;
/** The queued off-path paint (requestIdleCallback or rAF), if pending. */
let preRenderRaf: number | null = null;
/** The upcoming-pattern prop value the pending paint was queued for. */
let preRenderTarget: UpcomingPatternInfo | null = null;

type IdleCb = (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void;
type IdleId = number;
interface IdleWindow {
  requestIdleCallback?: (cb: IdleCb, opts?: { timeout: number }) => IdleId;
  cancelIdleCallback?: (id: IdleId) => void;
}

/**
 * Paint the queued upcoming pattern into the second bitmap of the ping-pong
 * pair. Runs off the critical path (requestIdleCallback, else a low-priority
 * rAF), never in the swap frame.
 */
function paintPreRender(): void {
  preRenderRaf = null;
  const upcoming = preRenderTarget;
  preRenderTarget = null;
  if (!bitmap || !upcoming || upcoming.rows <= 0 || upcoming.tracks.length === 0) {
    return;
  }
  // Size the ping-pong surface for the upcoming extent, at the same scale
  // ensureBitmap would give that extent -- which is the screen's DPR unless
  // the pattern is too big to paint at it. A surface sized any other way
  // could not be adopted, and the swap would repaint from scratch.
  const extent = preRenderExtent(upcoming, props.showExtraEffectColumn);
  const scale = bitmapScaleFor(
    extent.width,
    extent.height,
    dpr.value,
    bitmapBudget.value,
  );
  if (scale === null) {
    // Beyond this renderer; the swap will take the full-paint path, which
    // reports the failure and hands over to the DOM grid.
    preRenderMeta = null;
    return;
  }
  const deviceW = Math.max(1, Math.ceil(extent.width * scale));
  const deviceH = Math.max(1, Math.ceil(extent.height * scale));
  let surface = preRenderBitmap;
  if (!surface || surface.width !== deviceW || surface.height !== deviceH) {
    surface = null;
    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        surface = new OffscreenCanvas(deviceW, deviceH);
      } catch {
        surface = null;
      }
    }
    if (!surface) {
      const el = document.createElement('canvas');
      el.width = deviceW;
      el.height = deviceH;
      surface = el;
    }
    preRenderBitmap = surface;
  }
  const rawCtx = surface.getContext('2d');
  if (!rawCtx) {
    preRenderMeta = null;
    return;
  }
  rawCtx.setTransform(scale, 0, 0, scale, 0, 0);
  if (!paintUpcoming(surface, upcoming, props.showExtraEffectColumn, props.selectionRect)) {
    preRenderMeta = null;
    return;
  }
  preRenderMeta = metaFromInfo(upcoming, props.showExtraEffectColumn, props.selectionRect);
}

/** Queue the off-path pre-render paint (idle when available, else rAF). */
function schedulePreRender(info: UpcomingPatternInfo | null): void {
  const targetChanged = info !== preRenderTarget;
  preRenderTarget = info;
  if (!info) {
    preRenderMeta = null;
    return;
  }
  if (preRenderRaf !== null && !targetChanged) return;
  cancelPreRenderPaint();
  const w = window as unknown as IdleWindow;
  if (typeof w.requestIdleCallback === 'function') {
    // Under continuous playback the main thread may never truly idle, so
    // this carries the same { timeout: 150 } contract as
    // scheduleBrightRowTextRebake: the pre-render runs at the next idle
    // slot or within ~150 ms, whichever comes first, never starving
    // indefinitely (MAJOR-3).
    preRenderRaf = w.requestIdleCallback(() => paintPreRender(), { timeout: 150 });
  } else {
    preRenderRaf = requestAnimationFrame(paintPreRender);
  }
}

function cancelPreRenderPaint(): void {
  if (preRenderRaf === null) return;
  const w = window as unknown as IdleWindow;
  if (typeof w.cancelIdleCallback === 'function') {
    w.cancelIdleCallback(preRenderRaf);
  } else {
    cancelAnimationFrame(preRenderRaf);
  }
  preRenderRaf = null;
}

/**
 * Blit the visible slice of the bitmap onto the screen. Runs with an
 * identity transform: blitWindow already speaks device pixels on both
 * sides, so no scaling is applied here. The view origin is passed in —
 * runFrame reads it once per frame and both paint passes use that one
 * value, so the grid and the indicator layer can never disagree about
 * where the view is.
 */
function paintVisible(vt: number, vl: number): boolean {
  const canvas = visibleCanvasRef.value;
  if (!canvas || viewportW.value <= 0 || viewportH.value <= 0) return true;
  const ctx = canvas.getContext('2d');
  if (!ctx) return failRenderer('pattern-canvas: visible canvas 2D context unavailable');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bitmap || contentWidth.value <= 0 || totalRowsHeight.value <= 0) return true;
  const win = blitWindow(
    vt,
    vl,
    viewportW.value,
    viewportH.value,
    contentWidth.value,
    totalRowsHeight.value,
    dpr.value,
    bitmapDpr,
  );
  if (win.sw <= 0 || win.sh <= 0) return true;
  ctx.drawImage(
    bitmap as CanvasImageSource,
    win.sx,
    win.sy,
    win.sw,
    win.sh,
    win.dx,
    win.dy,
    win.dw,
    win.dh,
  );
  return true;
}

/**
 * What the overlay currently shows, so an indicator-only repaint knows
 * which viewport bands to clear (pattern-bands).
 */
let overlayPainted: OverlayFootprint | null = null;
/**
 * Structural changes (mount, resize, theme flip) force one full overlay
 * paint; indicator/scroll frames repaint bands only.
 */
let overlayFullPaint = true;

/**
 * The playback bar and editing cursor: everything that moves with the song
 * or the cursor and must not repaint the static bitmap.
 *
 * Band repaint, not full clear: each frame clears ONLY the viewport bands
 * the previous paint's indicators occupied (at that paint's own view
 * origin) and the current ones occupy. The pristine background a cleared
 * band reveals is the static bitmap slice the visible layer blits beneath
 * this overlay — never a snapshot of a live canvas, which could go stale
 * (cell edits during playback, theme flips) and silently restore wrong
 * pixels. Structural changes set `overlayFullPaint` and take the whole-
 * layer clear instead.
 *
 * The view origin arrives as the frame's single snapshot (runFrame reads
 * viewTop/viewLeft once), so the translate and the blit beneath all speak
 * the same scroll state.
 */
function paintOverlay(vt: number, vl: number): boolean {
  const canvas = overlayCanvasRef.value;
  if (!canvas) return true;
  const ctx = canvas.getContext('2d');
  if (!ctx) return failRenderer('pattern-canvas: overlay canvas 2D context unavailable');
  const l = layout.value;
  const barRow =
    props.playbackRow >= 0 && props.playbackRow < l.rowCount ? props.playbackRow : -1;
  const cursorRect =
    props.activeTrack >= 0 && props.activeColumn >= 0
      ? cursorCellRect(l, props.tracks, {
          trackIndex: props.activeTrack,
          row: props.selectedRow,
          column: props.activeColumn,
          macroNibble: props.activeMacroNibble,
        })
      : null;
  // The trail is painted above barRow while playing; the footprint carries its
  // depth so the clear band spans it and a moving playhead leaves no smear.
  const next: OverlayFootprint = {
    barRow,
    trailRows: props.isPlaying && barRow >= 0 ? PLAYBACK_TRAIL_ALPHAS.length : 0,
    cursor: cursorRect,
    viewTop: vt,
    viewLeft: vl,
  };

  ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0);
  const full = overlayFullPaint || overlayPainted === null;
  if (full) {
    ctx.clearRect(0, 0, viewportW.value, viewportH.value);
  } else {
    for (const band of overlayClearBands(
      overlayPainted,
      next,
      viewportW.value,
      viewportH.value,
    )) {
      ctx.clearRect(band.x, band.y, band.width, band.height);
    }
  }
  // The bar/cursor draw ops speak pattern space (rowY, entryBoxRect) while
  // this canvas is viewport-sized: shift the layer so the ops land on the
  // visible rows. Both offsets derive from the same frame's vt/vl the band
  // math above used.
  ctx.save();
  ctx.translate(GUTTER_WIDTH_PX - vl, -vt);
  const theme = getTheme();
  if (barRow >= 0) {
    drawActiveRowBar(ctx, l, theme, {
      playbackRow: barRow,
      mode: props.playbackMode as PlaybackBarMode,
      trackCount: l.trackCount,
      // No gutter pin: the gutter pill scrolls with the pattern, staying on
      // the row-number labels the static bitmap paints at its x [0, 78) —
      // labels this same frame's blit pans by −vl. The DOM grid scrolls its
      // row column with the tracks on the phone layout this renderer mostly
      // serves, and Morten's phone check confirmed the old viewport-edge pin
      // clung over scrolled-away content.
    });
  }
  // Bright playing-row TEXT: only on the playing row, only during playback.
  // One drawImage of the pre-baked bright strip over the row the bar sits on
  // — the pill fill/border stay exactly as drawActiveRowBar left them, only
  // the glyphs on top brighten. The bar's clear band (pattern-bands) already
  // spans this whole row, so a moving playhead leaves no stale bright text.
  if (props.isPlaying && barRow >= 0 && bitmap) {
    ensureBrightRowText();
    const strip = brightRowTextBitmap;
    if (strip) {
      const sh = rowHeightPx * bitmapDpr;
      // Trail first, so the playing row's own strip composites on top of it
      // (they never overlap, but the playing row stays the last word) and so
      // the overlay's drawImage order reads playhead-last.
      //
      // Only the spans that carry a note or an effect (buildTrailSpanIndex),
      // each at its row's alpha: the bright glyphs blend into the plain ones
      // the static bitmap already drew, so alpha interpolates between the two
      // text states and the pattern's events fade out behind the playhead
      // instead of a solid block of text.
      if (!trailSpanIndex) trailSpanIndex = buildTrailSpanIndex(l, props.tracks);
      for (let i = 0; i < PLAYBACK_TRAIL_ALPHAS.length; i++) {
        const row = barRow - 1 - i;
        if (row < 0) break;
        const spans = trailSpanIndex.get(row);
        if (!spans) continue;
        ctx.globalAlpha = PLAYBACK_TRAIL_ALPHAS[i]!;
        const trailSy = rowY(row) * bitmapDpr;
        for (const span of spans) {
          ctx.drawImage(
            strip as CanvasImageSource,
            // Surface x 0 is the gutter's left edge, i.e. pattern x
            // −GUTTER_WIDTH_PX — the same mapping the full-row blit below uses.
            (span.x + GUTTER_WIDTH_PX) * bitmapDpr,
            trailSy,
            span.width * bitmapDpr,
            sh,
            span.x,
            rowY(row),
            span.width,
            rowHeightPx,
          );
        }
      }
      ctx.globalAlpha = 1;
      const sy = rowY(barRow) * bitmapDpr;
      ctx.drawImage(
        strip as CanvasImageSource,
        0,
        sy,
        strip.width,
        sh,
        -GUTTER_WIDTH_PX,
        rowY(barRow),
        contentWidth.value,
        rowHeightPx,
      );
    }
  }
  if (cursorRect) {
    drawCursorCell(ctx, l, props.tracks, theme, {
      trackIndex: props.activeTrack,
      row: props.selectedRow,
      column: props.activeColumn,
      macroNibble: props.activeMacroNibble,
    });
  }
  ctx.restore();
  overlayPainted = next;
  overlayFullPaint = false;
  return true;
}

// ---------------------------------------------------------------------
// rAF-coalesced draw scheduler
// ---------------------------------------------------------------------

let frameRaf: number | null = null;
let wantStatic = false;
let wantOverlay = false;
let wantBlit = false;

function schedule(parts: Array<'static' | 'overlay' | 'blit'>): void {
  for (const part of parts) {
    if (part === 'static') wantStatic = true;
    else if (part === 'overlay') wantOverlay = true;
    else wantBlit = true;
  }
  if (frameRaf !== null) return;
  frameRaf = requestAnimationFrame(runFrame);
}

function runFrame(): void {
  frameRaf = null;
  const followMoved = applyFollow() || applyCursorFollow();
  // One frame, one composition: the view origin is read exactly once, after
  // the follow applied, and the same values drive the blit and the overlay
  // paint. No pass can observe a mid-frame scroll write the other missed.
  // Snapped to whole device pixels (pattern-window): the compositor snaps
  // the sticky canvas stack's own position the same way, so painting at the
  // unrounded offset would move the content half a pixel against the
  // element carrying it, re-decided every scroll step.
  const viewTopFrame = snapToDevicePx(viewTop.value, dpr.value);
  const viewLeftFrame = snapToDevicePx(viewLeft.value, dpr.value);
  const drawStatic = wantStatic;
  const drawOverlay = wantOverlay;
  const blit = wantBlit || drawStatic || followMoved;
  wantStatic = false;
  wantOverlay = false;
  wantBlit = false;
  if (drawStatic) {
    // Fast paths before the full repaint: a playback swap adopts the
    // pre-rendered bitmap (pointer swap, §3.2), and a cell-level edit
    // repairs only the changed cells (§3.3). Either way the frame still
    // blits the (updated) bitmap below.
    let staticPainted = false;
    if (bitmap && preRenderBitmap && preRenderMeta) {
      // The bitmap must fit the arriving pattern exactly — its extent was
      // sized for the pre-render target, and a mismatch would smear the
      // blit. Painted meta carries that extent.
      // The scale that extent would be painted at now: a pre-render made
      // before a DPR change (or for a pattern of a different size) is sized
      // for a scale this frame would not choose, and adopting it would blit
      // the wrong number of source pixels.
      const preScale = bitmapScaleFor(
        preRenderMeta.cssWidth,
        preRenderMeta.cssHeight,
        dpr.value,
        bitmapBudget.value,
      );
      const sizedOk =
        preScale !== null &&
        bitmapCssWidth === preRenderMeta.cssWidth &&
        bitmapCssHeight === preRenderMeta.cssHeight &&
        preRenderBitmap.width === Math.max(1, Math.ceil(preRenderMeta.cssWidth * preScale)) &&
        preRenderBitmap.height === Math.max(1, Math.ceil(preRenderMeta.cssHeight * preScale));
      if (
        sizedOk &&
        canAdoptPreRender(
          preRenderMeta,
          props.tracks,
          props.rows,
          props.showExtraEffectColumn,
          props.selectionRect,
        )
      ) {
        // Ping-pong: the pre-render becomes the static bitmap; the old
        // static surface is recycled as the next pre-render target.
        const adopted = bitmap;
        bitmap = preRenderBitmap;
        preRenderBitmap = adopted;
        bitmapKey = `${bitmap.width}x${bitmap.height}`;
        bitmapDpr = preScale as number;
        bitmapCssWidth = contentWidth.value;
        bitmapCssHeight = totalRowsHeight.value;
        // The cell-repair bookkeeping must describe the bitmap now on screen.
        paintedState = buildPaintState(
          props.tracks,
          props.rows,
          props.showExtraEffectColumn,
          props.selectionRect,
        );
        // The adopted bitmap is a different pattern at a possibly different
        // scale; the bright playing-row text must rebake against it — but off
        // this critical swap frame (MAJOR-2). The row shows plain static text
        // until the deferred bake lands (idle-first, ≤150 ms bound).
        scheduleBrightRowTextRebake();
        preRenderMeta = null;
        preRenderTarget = null;
        schedulePreRender(props.upcomingPattern);
        staticPainted = true;
      }
    }
    if (!staticPainted && paintedState && bitmap) {
      // The incremental path repairs a bitmap that is still the right shape:
      // same extent, same scale. A resize or a DPR change must fall through
      // to the full paint, which rebuilds the backing store -- and the scale
      // to compare against is the one this extent fits at, which is below
      // the screen's DPR for a pattern too big to paint at full resolution.
      const bitmapValid =
        bitmapCssWidth === contentWidth.value &&
        bitmapCssHeight === totalRowsHeight.value &&
        bitmapDpr ===
          bitmapScaleFor(
            contentWidth.value,
            totalRowsHeight.value,
            dpr.value,
            bitmapBudget.value,
          );
      if (bitmapValid) {
        const diffs = diffPaintState(
          paintedState,
          props.tracks,
          props.rows,
          props.showExtraEffectColumn,
          props.selectionRect,
        );
        if (diffs !== null) {
          staticPainted = diffs.length === 0 || repaintCells(diffs);
        }
      }
    }
    if (!staticPainted && !paintStatic()) return;
  }
  if (blit && !paintVisible(viewTopFrame, viewLeftFrame)) return;
  if (drawOverlay && !paintOverlay(viewTopFrame, viewLeftFrame)) return;
}

// ---------------------------------------------------------------------
// Sizing: DPR backing stores, rAF-coalesced ResizeObserver
// ---------------------------------------------------------------------

function applySize(): void {
  const scroller = scrollerRef.value;
  if (!scroller) return;
  const nextDpr = window.devicePixelRatio || 1;
  // The canvas stack's real box, not the scroller's rounded clientWidth/
  // clientHeight: those are integers, while the box they describe is
  // whatever fraction of a CSS pixel the flex layout produced. Sizing the
  // backing store from the rounded number and letting CSS stretch it back
  // over the true box re-samples every pixel the renderer draws.
  const box = viewportRef.value?.getBoundingClientRect();
  const boxW = box && box.width > 0 ? box.width : scroller.clientWidth;
  const boxH = box && box.height > 0 ? box.height : scroller.clientHeight;
  // Whole device pixels, and the CSS size pinned to exactly that many, so
  // the backing store maps 1:1 onto the screen and nothing the blit writes
  // is resampled on the way out.
  const backingW = Math.max(1, Math.round(boxW * nextDpr));
  const backingH = Math.max(1, Math.round(boxH * nextDpr));
  const w = backingW / nextDpr;
  const h = backingH / nextDpr;
  // The bitmap depends on the pattern extent and the DPR, not the viewport:
  // a resize that changes neither leaves it valid and only the visible
  // layers need painting.
  const bitmapInputsChanged =
    nextDpr !== dpr.value ||
    contentWidth.value !== bitmapCssWidth ||
    totalRowsHeight.value !== bitmapCssHeight;
  viewportW.value = w;
  viewportH.value = h;
  dpr.value = nextDpr;
  // The band bookkeeping describes screen positions the resized viewport
  // may have shifted; the next overlay paint repaints the whole layer.
  overlayFullPaint = true;
  for (const canvas of [visibleCanvasRef.value, overlayCanvasRef.value]) {
    if (!canvas) continue;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
  }
  // A backing-store reset clears the layer, so both visible layers always
  // repaint; the static bitmap only rebuilds when the pattern's own extent
  // or the DPR changed (otherwise the blit reuses it as-is). The ping-pong
  // surface follows the same extent/DPR inputs, so a pending pre-render is
  // queued again and rebuilt at the new scale.
  if (bitmapInputsChanged) invalidateBrightRowText();
  schedule(bitmapInputsChanged ? ['static', 'overlay', 'blit'] : ['overlay', 'blit']);
  if (bitmapInputsChanged) schedulePreRender(props.upcomingPattern);
}

let resizeRaf: number | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;

// ---------------------------------------------------------------------
// Scroll plumbing
// ---------------------------------------------------------------------

const lastEmitted = { top: -1, left: -1 };

function emitScroll(): void {
  if (lastEmitted.top === viewTop.value && lastEmitted.left === viewLeft.value) return;
  lastEmitted.top = viewTop.value;
  lastEmitted.left = viewLeft.value;
  emit('scroll', { top: viewTop.value, left: viewLeft.value });
}

/*
 * The dead zone is one device pixel, not one CSS pixel: what the frame
 * paints is the offset snapped to a device pixel (runFrame), so two
 * scrollTops that snap to different device pixels are two different
 * pictures however close they are in CSS space. A wheel or trackpad scroll
 * delivers fractional offsets, and holding the old one back because it
 * moved "less than half a pixel" leaves the content a device pixel away
 * from where the compositor put the canvas carrying it.
 */
function onScrollerScroll(): void {
  const el = scrollerRef.value;
  if (!el) return;
  const next = el.scrollTop;
  const d = dpr.value;
  if (snapToDevicePx(next, d) === snapToDevicePx(viewTop.value, d)) return;
  viewTop.value = next;
  emitScroll();
  // The overlay's pattern→viewport translate reads viewTop/viewLeft, so a
  // scroll must repaint it alongside the blit.
  schedule(['blit', 'overlay']);
}

function onHScroll(): void {
  const el = hscrollRef.value;
  if (!el) return;
  const next = el.scrollLeft;
  const d = dpr.value;
  if (snapToDevicePx(next, d) === snapToDevicePx(viewLeft.value, d)) return;
  viewLeft.value = next;
  emitScroll();
  schedule(['blit', 'overlay']);
}

/** External scroll (auto-scroll, page state): adopt, sync the scrollers. */
watch(
  () => props.scrollTop,
  (v) => {
    if (Math.abs(v - viewTop.value) < 0.5) return;
    // Self-echo: a value we emitted ourselves round-tripping through the
    // page state. Drop it instead of force-resyncing the scroller — the
    // user may already have scrolled past it, and snapping back would
    // revert their scroll. A genuinely external change never equals our
    // last emission and still resyncs below.
    if (Math.abs(v - lastEmitted.top) < 0.5) return;
    viewTop.value = v;
    const el = scrollerRef.value;
    if (el && Math.abs(el.scrollTop - v) >= 0.5) el.scrollTop = v;
    schedule(['blit', 'overlay']);
  },
);

watch(
  () => props.scrollLeft,
  (v) => {
    if (Math.abs(v - viewLeft.value) < 0.5) return;
    if (Math.abs(v - lastEmitted.left) < 0.5) return;
    viewLeft.value = v;
    const el = hscrollRef.value;
    if (el && Math.abs(el.scrollLeft - v) >= 0.5) el.scrollLeft = v;
    schedule(['blit', 'overlay']);
  },
);

/**
 * Follow the playback row while playing, with the DOM grid's exact behavior:
 * every playbackRow change centers the playing row (one row pitch of scroll
 * per step), so vertical playback scroll advances exactly one row at a
 * time. The request only flags the follow — the DOM write, the view
 * adoption and the repaint all happen inside the coalesced rAF frame, never
 * synchronously on the prop change.
 */
let pendingFollow = false;

/**
 * Gesture ownership of the view. While a touch pan or its fling owns the
 * scrollers — and for a short grace period after the last gesture event —
 * follow-playback must not write the view: the user owns it. The DOM grid's
 * own anti-fight rule (TrackerPattern: "Avoid fighting with mouse selection;
 * let user control scroll while selecting") extended to touch, because here
 * the fight is visible as paint: a follow write interleaves between pan
 * frames and the same rAF paints one full frame at the center-wrong position
 * before the next touchmove restores the pan (the 2026-09-04 round-3
 * report). Like the DOM grid, follow resumes at the NEXT playbackRow change
 * once the gesture (and the grace period) is over — it never re-centers on
 * its own mid-playback. A follow requested during the gesture is dropped,
 * not queued: applying a center computed for a row the user scrolled away
 * from would be the same snap we are suppressing.
 */
const FOLLOW_GRACE_AFTER_GESTURE_MS = 350;
/** True while a finger is down or a fling is coasting. */
let gestureActive = false;
/** performance.now() deadline that outlives the gesture briefly. */
let gestureOwnedUntil = -1;

function markGestureActivity(): void {
  gestureOwnedUntil = performance.now() + FOLLOW_GRACE_AFTER_GESTURE_MS;
}

function gestureOwnsView(): boolean {
  return gestureActive || performance.now() < gestureOwnedUntil;
}

function requestFollow(): void {
  pendingFollow = true;
  schedule([]); // a frame may not be queued yet (e.g. the mount path)
}

/** Runs at the top of runFrame. Returns whether viewTop moved. */
function applyFollow(): boolean {
  if (!pendingFollow) return false;
  pendingFollow = false;
  if (!props.autoScroll || !props.isPlaying) return false;
  // A pan or fling in flight (or just finished) owns the view: no write, no
  // paint at the follow target. The next playbackRow change re-requests.
  if (gestureOwnsView()) return false;
  const row = props.playbackRow;
  if (row < 0 || row >= props.rows) return false;
  const y = rowY(row);
  const viewH = viewportH.value || props.containerHeight;
  const maxScroll = Math.max(0, totalRowsHeight.value - viewH);
  let target: number;
  if (props.granularScroll) {
    // Row-granular (the DOM grid's behavior): center the playing row every
    // step, so vertical playback scroll advances exactly one row pitch per
    // step. Clamped to the scroll extent the spacer defines.
    target = snapToDevicePx(
      Math.min(Math.max(0, y - (viewH - rowHeightPx) / 2), maxScroll),
      dpr.value,
    );
  } else {
    // Paged: only re-anchor once the row leaves a 3-row margin, jumping it
    // roughly a third from the top.
    const top = viewTop.value;
    const margin = rowPitchPx * 3;
    if (y >= top + margin && y + rowHeightPx <= top + viewH - margin) return false;
    target = snapToDevicePx(
      Math.min(Math.max(0, y - (viewH - rowHeightPx) / 3), maxScroll),
      dpr.value,
    );
  }
  const el = scrollerRef.value;
  if (el) el.scrollTop = target;
  if (Math.abs(viewTop.value - target) < 0.5) return false;
  viewTop.value = target;
  emitScroll();
  return true;
}

watch(
  () => [props.playbackRow, props.isPlaying, props.autoScroll, viewportH.value],
  () => {
    requestFollow();
    schedule(['overlay']);
  },
);

/**
 * Follow the *editing cursor* while stopped — the other half of the DOM
 * grid's scroll target, which the canvas never carried over.
 *
 * TrackerPattern resolves one target for both jobs:
 *
 *   if (!autoScroll) return null;
 *   if (isPlaying) return playbackRow;
 *   if (isMouseSelecting) return null;   // let the drag own the view
 *   return selectedRow;
 *
 * Only the `playbackRow` branch was ported, so `selectedRow` reached the
 * canvas as something to *draw* and never as something to scroll to. The
 * arrow keys and PageUp/PageDown still moved the cursor — the keyboard layer
 * was never involved — but the view stayed put, so once the cursor left the
 * viewport the pattern appeared frozen and unnavigable (Morten, 2026-09-04).
 *
 * Same centering and the same clamp as the playback follow, and the same
 * gesture-ownership rule (D105): a pan in flight owns the view.
 */
let pendingCursorFollow = false;

function applyCursorFollow(): boolean {
  if (!pendingCursorFollow) return false;
  pendingCursorFollow = false;
  if (!props.autoScroll) return false;
  // Playback owns the view while it runs; applyFollow has already had its
  // turn this frame.
  if (props.isPlaying) return false;
  // Don't fight a selection drag or a touch pan.
  if (props.isMouseSelecting) return false;
  if (gestureOwnsView()) return false;
  const row = props.selectedRow;
  if (row < 0 || row >= props.rows) return false;
  const viewH = viewportH.value || props.containerHeight;
  if (viewH <= 0) return false;
  const maxScroll = Math.max(0, totalRowsHeight.value - viewH);
  const target = snapToDevicePx(
    Math.min(Math.max(0, rowY(row) - (viewH - rowHeightPx) / 2), maxScroll),
    dpr.value,
  );
  if (Math.abs(viewTop.value - target) < 0.5) return false;
  const el = scrollerRef.value;
  if (el) el.scrollTop = target;
  viewTop.value = target;
  emitScroll();
  return true;
}

watch(
  () => [props.selectedRow, props.isPlaying, props.autoScroll],
  () => {
    pendingCursorFollow = true;
    schedule(['overlay']);
  },
);

// ---------------------------------------------------------------------
// Static-bitmap inputs: track identity/size, selection, theme
// ---------------------------------------------------------------------

watch(
  () => [props.tracks, props.rows, props.showExtraEffectColumn, props.selectionRect],
  () => schedule(['static']),
);

/**
 * Upcoming-pattern feeds: queue the off-path pre-render of the next pattern
 * while it plays; a null (stopped, deleted pattern) cancels any pending one.
 */
watch(
  () => props.upcomingPattern,
  (info) => schedulePreRender(info),
);

watch(
  () => [props.playbackMode, props.activeTrack, props.activeColumn, props.activeMacroNibble],
  () => schedule(['overlay']),
);

// ---------------------------------------------------------------------
// Pointer → cell
// ---------------------------------------------------------------------

let downHit: PatternHit | null = null;
let dragging = false;

function eventPoint(e: MouseEvent): { x: number; y: number } | null {
  const canvas = overlayCanvasRef.value;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

/** Viewport point → cell, subtracting the gutter the bitmap paints. */
function hitAtPoint(point: { x: number; y: number } | null): PatternHit | null {
  if (!point) return null;
  return hitTest(point.x + viewLeft.value - GUTTER_WIDTH_PX, point.y, layout.value, viewTop.value);
}

function rowAtPoint(point: { x: number; y: number } | null): number | null {
  if (!point || point.y < 0) return null;
  const localY = point.y + viewTop.value;
  const row = Math.floor(localY / rowPitchPx);
  if (row < 0 || row >= props.rows) return null;
  if (localY % rowPitchPx >= rowHeightPx) return null;
  return row;
}

/**
 * A tap emits a synthetic mousedown/mouseup pair a moment later. Ours has
 * already selected the cell by then, and letting the mouse path run as well
 * would open a selection drag from it.
 */
const SYNTHETIC_MOUSE_WINDOW_MS = 700;
let lastTouchAt = -Infinity;

function onCanvasMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
  if (e.timeStamp - lastTouchAt < SYNTHETIC_MOUSE_WINDOW_MS) return;
  const point = eventPoint(e);
  const contentX = point ? point.x + viewLeft.value : 0;
  if (contentX < GUTTER_WIDTH_PX) {
    const row = rowAtPoint(point);
    if (row !== null) emit('rowSelected', row);
    return;
  }
  const hit = hitAtPoint(point);
  if (!hit) return;
  downHit = hit;
  dragging = true;
  emit('startSelection', { row: hit.row, trackIndex: hit.trackIndex });
}

function onWindowMouseMove(e: MouseEvent): void {
  if (!dragging) return;
  const hit = hitAtPoint(eventPoint(e));
  if (!hit) return;
  emit('hoverSelection', { row: hit.row, trackIndex: hit.trackIndex });
}

function onWindowMouseUp(e: MouseEvent): void {
  if (!dragging) return;
  dragging = false;
  const start = downHit;
  downHit = null;
  if (!start) return;
  // A click: down and up on the same cell. A drag that ends elsewhere is a
  // selection, not a cell pick.
  const hit = hitAtPoint(eventPoint(e));
  if (!hit) return;
  if (
    hit.row !== start.row ||
    hit.trackIndex !== start.trackIndex ||
    hit.column !== start.column ||
    hit.macroNibble !== start.macroNibble
  ) {
    return;
  }
  // exactOptionalPropertyTypes: the key is either absent or a number.
  emit(
    'cellSelected',
    hit.macroNibble === undefined
      ? { row: hit.row, column: hit.column, trackIndex: hit.trackIndex }
      : {
          row: hit.row,
          column: hit.column,
          trackIndex: hit.trackIndex,
          macroNibble: hit.macroNibble,
        },
  );
}

// ---------------------------------------------------------------------
// Wheel: route horizontal intent to the proxy scrollbar
// ---------------------------------------------------------------------

function onWheel(e: WheelEvent): void {
  if (e.ctrlKey) return;
  const horizontalIntent = Math.abs(e.deltaX) > Math.abs(e.deltaY);
  if (!horizontalIntent && !e.shiftKey) return; // native vertical scroll
  e.preventDefault();
  const el = hscrollRef.value;
  if (!el) return;
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 0) return;
  const delta = horizontalIntent ? e.deltaX : e.deltaY;
  const target = Math.max(0, Math.min(max, el.scrollLeft + delta));
  if (Math.abs(target - el.scrollLeft) < 0.5) return;
  el.scrollLeft = target; // scroll event runs the blit pipeline
}

// ---------------------------------------------------------------------
// Touch: one finger pans both axes; a tap still picks a cell
// ---------------------------------------------------------------------

/**
 * The scroller only scrolls vertically -- horizontal lives on the proxy
 * scrollbar -- so a finger dragged across the grid could reach half the
 * pattern at best, and on a phone the half it could not reach is most of it.
 * This drives both from one gesture.
 *
 * Any number of fingers pans, using the first: one finger is the obvious
 * gesture for a surface you drag, and two is the habit a scrollable pane
 * teaches, so both work rather than one of them doing nothing. What a pan
 * costs is dragging out a selection by touch, which is why a tap (little
 * movement, quickly released) still falls through to the cell pick the
 * mouse path does.
 */
let touchOrigin: TouchPanOrigin | null = null;
let touchSamples: FlingSample[] = [];
let flingRaf: number | null = null;

function maxScrollTop(): number {
  const el = scrollerRef.value;
  return el ? Math.max(0, el.scrollHeight - el.clientHeight) : 0;
}

function maxScrollLeft(): number {
  const el = hscrollRef.value;
  return el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0;
}

function scrollTo(target: { scrollTop: number; scrollLeft: number }): void {
  // Both writes fire scroll events, which run the blit pipeline.
  if (scrollerRef.value) scrollerRef.value.scrollTop = target.scrollTop;
  if (hscrollRef.value) hscrollRef.value.scrollLeft = target.scrollLeft;
}

function stopFling(): void {
  if (flingRaf === null) return;
  cancelAnimationFrame(flingRaf);
  flingRaf = null;
  // Ownership flags are NOT touched here: the coast-stop branch in
  // startFling releases them when the decay finishes, and the only other
  // callers are onTouchStart (which re-asserts ownership for the catching
  // finger right after) and onBeforeUnmount (the component is going away).
  // Clearing here made a caught fling drop ownership while the finger was
  // still down -- after the grace, a held finger lost the view and the next
  // row advance re-centered under it (review finding on 9ff8abf).
}

function onTouchStart(e: TouchEvent): void {
  lastTouchAt = e.timeStamp;
  const touch = e.touches[0];
  if (!touch) return;
  // Catching a coasting fling with a finger is the standard idiom: stop the
  // coast FIRST (stopFling manages no ownership flags of its own), then take
  // ownership -- the finger owns the view from the moment it lands, however
  // long it then holds still.
  stopFling();
  gestureActive = true;
  markGestureActivity();
  touchOrigin = {
    x: touch.clientX,
    y: touch.clientY,
    scrollTop: scrollerRef.value?.scrollTop ?? 0,
    scrollLeft: hscrollRef.value?.scrollLeft ?? 0,
    time: e.timeStamp,
  };
  touchSamples = [{ x: touch.clientX, y: touch.clientY, time: e.timeStamp }];
}

function onTouchMove(e: TouchEvent): void {
  const origin = touchOrigin;
  const touch = e.touches[0];
  if (!origin || !touch) return;
  // The gesture owns both axes now; letting the browser also scroll the
  // page (or this scroller) would double every vertical drag.
  if (e.cancelable) e.preventDefault();
  // Every move re-arms the ownership deadline, so a pan that pauses between
  // two fingers' worth of frames is still covered.
  markGestureActivity();
  touchSamples.push({ x: touch.clientX, y: touch.clientY, time: e.timeStamp });
  if (touchSamples.length > 8) touchSamples.shift();
  scrollTo(
    panTarget(origin, touch.clientX, touch.clientY, maxScrollTop(), maxScrollLeft()),
  );
}

function onTouchEnd(e: TouchEvent): void {
  lastTouchAt = e.timeStamp;
  const origin = touchOrigin;
  touchOrigin = null;
  if (e.touches.length > 0) {
    // A second finger lifted while another stays down: the gesture is not
    // over, the remaining finger still owns the view.
    markGestureActivity();
  } else {
    gestureActive = false;
    markGestureActivity();
  }
  if (!origin) return;
  const touch = e.changedTouches[0];
  if (touch && isTap(origin, touch.clientX, touch.clientY, e.timeStamp)) {
    touchSamples = [];
    selectAtClientPoint(touch.clientX, touch.clientY);
    return;
  }
  const velocity = flingVelocity(touchSamples, e.timeStamp);
  touchSamples = [];
  if (!velocity) return;
  startFling(velocity.vx, velocity.vy);
}

function onTouchCancel(): void {
  touchOrigin = null;
  touchSamples = [];
  // touchcancel fires only when the whole gesture is aborted by the system,
  // so no e.touches check: every finger is gone.
  gestureActive = false;
  markGestureActivity();
}

/** Coast to a stop after the finger leaves, in scroll-space px/ms. */
function startFling(vx: number, vy: number): void {
  let velocityX = vx;
  let velocityY = vy;
  // The coast is still the user's gesture: follow stays suppressed until it
  // stops (or a new touch cancels it), however long the decay runs.
  gestureActive = true;
  let last = performance.now();
  const step = (now: number) => {
    flingRaf = null;
    // Clamped: a frame the tab spent in the background must not teleport
    // the pattern by a second's worth of momentum.
    const dt = Math.max(1, Math.min(64, now - last));
    last = now;
    scrollTo({
      scrollTop: clampScroll(
        (scrollerRef.value?.scrollTop ?? 0) + velocityY * dt,
        0,
        maxScrollTop(),
      ),
      scrollLeft: clampScroll(
        (hscrollRef.value?.scrollLeft ?? 0) + velocityX * dt,
        0,
        maxScrollLeft(),
      ),
    });
    // The decay is quoted per 60fps frame, so a slower frame decays more.
    const decay = Math.pow(FLING_DECAY, dt / (1000 / 60));
    velocityX *= decay;
    velocityY *= decay;
    if (Math.hypot(velocityX, velocityY) < FLING_STOP_VELOCITY) {
      // Coast finished: the ownership grace starts here, so the first row
      // change after the pattern settles re-centers (the DOM-grid rule).
      flingRaf = null;
      gestureActive = false;
      markGestureActivity();
      return;
    }
    flingRaf = requestAnimationFrame(step);
  };
  flingRaf = requestAnimationFrame(step);
}

function clampScroll(value: number, min: number, max: number): number {
  if (!(max > min)) return min;
  return Math.max(min, Math.min(max, value));
}

/** The tap path: the same row/cell selection a click makes. */
function selectAtClientPoint(clientX: number, clientY: number): void {
  const canvas = overlayCanvasRef.value;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const point = { x: clientX - rect.left, y: clientY - rect.top };
  if (point.x + viewLeft.value < GUTTER_WIDTH_PX) {
    const row = rowAtPoint(point);
    if (row !== null) emit('rowSelected', row);
    return;
  }
  const hit = hitAtPoint(point);
  if (!hit) return;
  emit(
    'cellSelected',
    hit.macroNibble === undefined
      ? { row: hit.row, column: hit.column, trackIndex: hit.trackIndex }
      : {
          row: hit.row,
          column: hit.column,
          trackIndex: hit.trackIndex,
          macroNibble: hit.macroNibble,
        },
  );
}

// ---------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------

onMounted(() => {
  // A theme flip while this component was unmounted (e.g. changed in
  // settings, then navigating back) rewrote :root with no observer
  // running — the module cache still holds the old palette, so re-read it
  // before the first paint.
  refreshTheme();
  themeRevision.value++;
  applySize();
  schedule(['static', 'overlay', 'blit']);
  requestFollow();
  if (typeof ResizeObserver !== 'undefined' && scrollerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (resizeRaf !== null) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        applySize();
      });
    });
    resizeObserver.observe(scrollerRef.value);
  }
  scrollerRef.value?.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  // Theme flips rewrite the CSS custom properties the palette is read from;
  // same watch as pattern-theme's own observer, plus a repaint. Theme
  // colors are baked into both bitmaps, and the static paint's fast paths
  // (pre-render adoption, cell-diff repair) key on content only — an
  // unchanged pattern would keep the old palette. Drop the paint
  // bookkeeping and the pre-render so the frame falls through to a full
  // repaint with the refreshed theme, and re-queue the pre-render.
  themeObserver = new MutationObserver(() => {
    refreshTheme();
    themeRevision.value++;
    paintedState = null;
    preRenderMeta = null;
    preRenderTarget = null;
    overlayFullPaint = true;
    // The bright playing-row text bakes the theme's colour in too.
    invalidateBrightRowText();
    schedulePreRender(props.upcomingPattern);
    schedule(['static', 'overlay']);
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class'],
  });
});

onBeforeUnmount(() => {
  themeObserver?.disconnect();
  themeObserver = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (resizeRaf !== null) {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = null;
  }
  if (frameRaf !== null) {
    cancelAnimationFrame(frameRaf);
    frameRaf = null;
  }
  cancelPreRenderPaint();
  cancelBrightRowTextRebake();
  stopFling();
  preRenderBitmap = null;
  preRenderMeta = null;
  preRenderTarget = null;
  brightRowTextSurface = null;
  brightRowTextBitmap = null;
  brightRowTextValid = false;
  paintedState = null;
  overlayPainted = null;
  overlayFullPaint = true;
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
});

defineExpose({ scrollerRef, hscrollRef });
</script>

<style scoped>
.pattern-canvas {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: 8px;
  /* Same spectrum-analyser gutter reserve as the DOM grid it replaces. */
  max-width: calc(100% - 2 * min(var(--tracker-side-gutter, 0px), 15%));
  /* Shrink-to-fit the pattern's natural width (the DOM grid is inline-flex),
     centered; the max-width cap above keeps analyser gutters outside. */
  width: var(--panel-width, auto);
  margin-inline: auto;
  background: var(--panel-background, #0c1018);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.06));
  border-radius: 16px;
  padding: 14px 18px 12px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  contain: layout style paint;
  user-select: none;
}

.canvas-header {
  position: relative;
  flex: none;
  height: 46px;
  overflow: hidden;
}

.canvas-header-inner {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  will-change: transform;
}

.header-row-label {
  position: absolute;
  left: 0;
  width: 78px;
  top: 50%;
  transform: translateY(-50%);
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted, #a7bcd8);
}

.header-track {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 3px 8px;
  border: 1px solid color-mix(in srgb, var(--track-accent, #5dd6ff) 45%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--track-accent, #5dd6ff) 10%, transparent);
  font-size: 11px;
  font-weight: 700;
  color: var(--tracker-default-text, #d8e7ff);
}

.header-track-index {
  color: var(--track-accent, #5dd6ff);
}

.header-track-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/*
 * Phone layout: the panel chrome is most of the width at 390px, and every
 * pixel it keeps is a pixel of pattern nobody can see. Matches
 * useMobileLayout's query, so the page and the panel agree on what a phone
 * is; this one is cosmetic, hence a media query rather than a prop.
 */
@media (max-width: 900px), (pointer: coarse) and (max-width: 1180px) {
  .pattern-canvas {
    padding: 6px 6px 4px;
    border-radius: 10px;
    gap: 4px;
    box-shadow: none;
    max-width: 100%;
  }
}

.canvas-scroller {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden auto;
  scrollbar-width: thin;
  /* Theme-matched bars (theme-store palette vars, so runtime theme flips
     repaint them); same look as the DOM grid's .pattern-area scrollbars. */
  scrollbar-color: var(--button-background, rgba(255, 255, 255, 0.12)) transparent;
}

.canvas-scroller::-webkit-scrollbar {
  width: 8px;
}

.canvas-scroller::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
}

.canvas-scroller::-webkit-scrollbar-thumb:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.18));
}

.canvas-scroller::-webkit-scrollbar-track {
  background: transparent;
}

.canvas-viewport {
  position: sticky;
  top: 0;
  height: 100%;
  z-index: 1;
}

.canvas-layer {
  position: absolute;
  inset: 0;
  display: block;
  /* The touch gesture drives both scroll axes itself (see onTouchMove), so
     the browser must not also pan, zoom or double-tap-zoom the surface. */
  touch-action: none;
  width: 100%;
  height: 100%;
}

.canvas-spacer {
  position: absolute;
  top: 0;
  left: 0;
  pointer-events: none;
}

.canvas-hscroll {
  flex: none;
  height: 12px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  /* Same theme-matched pill as TrackerPage's .track-scrollbar proxy. */
  scrollbar-color: var(--button-background, rgba(255, 255, 255, 0.12)) transparent;
}

.canvas-hscroll::-webkit-scrollbar {
  height: 12px;
}

.canvas-hscroll::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.14));
  border-radius: 999px;
  border: 3px solid transparent;
  background-clip: content-box;
}

.canvas-hscroll::-webkit-scrollbar-thumb:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.24));
  background-clip: content-box;
}

.canvas-hscroll::-webkit-scrollbar-track {
  background: transparent;
}

.canvas-hscroll-extent {
  height: 1px;
}
</style>

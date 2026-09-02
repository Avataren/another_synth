<template>
  <div class="pattern-canvas" :style="{ '--tracker-side-gutter': sideGutter }">
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
          :style="headerTrackStyle(index, track)"
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
      <div class="canvas-viewport">
        <canvas ref="visibleCanvasRef" class="canvas-layer"></canvas>
        <canvas
          ref="overlayCanvasRef"
          class="canvas-layer"
          @mousedown="onCanvasMouseDown"
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
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowPitchPx,
  rowY,
  totalTracksWidth,
  type PatternLayout,
} from './pattern-layout';
import { hitTest, type PatternHit } from './pattern-hit-test';
import { blitWindow } from './pattern-window';
import {
  drawActiveRowBar,
  drawCursorCell,
  drawRowNumbers,
  drawSelectionBar,
  drawStaticGrid,
  trackAccent,
  type PlaybackBarMode,
} from './pattern-draw';
import { getTheme, refresh as refreshTheme } from './pattern-theme';
import { trackPitchPx, trackWidthPx } from '../track-metrics';
import type { TrackerSelectionRect, TrackerTrackData } from '../tracker-types';

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
   * Reserved for the editing cursor's keyboard wiring: pointer selection and
   * cell events emit regardless, exactly as the DOM grid does, so the page's
   * own edit-mode handlers stay the single gate.
   */
  enableEditing?: boolean;
  /**
   * The double-buffered pre-render of the pattern coming next. Not used yet:
   * the canvas renderer redraws a full pattern in one bitmap paint, which has
   * so far been fast enough to make the flip invisible.
   */
  upcomingPattern?: { id: string; tracks: TrackerTrackData[]; rows: number } | null;
}

const props = withDefaults(defineProps<Props>(), {
  scrollLeft: 0,
  containerWidth: 0,
  enableEditing: false,
  upcomingPattern: null,
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
const visibleCanvasRef = ref<HTMLCanvasElement | null>(null);
const overlayCanvasRef = ref<HTMLCanvasElement | null>(null);

/** View origin in pattern space; the props are the external source of truth. */
const viewTop = ref(props.scrollTop);
const viewLeft = ref(props.scrollLeft);
/** Measured scroller size; the container props only seed the first frame. */
const viewportW = ref(Math.max(0, props.containerWidth));
const viewportH = ref(Math.max(0, props.containerHeight));
const dpr = ref(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1);

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

const sideGutter = computed(() =>
  props.reserveSideGutter
    ? `${trackWidthPx(props.tracks.length, props.showExtraEffectColumn)}px`
    : '0px',
);

const hscrollVisible = computed(() => contentWidth.value > viewportW.value);

const headerShift = computed(() => ({ transform: `translateX(${-viewLeft.value}px)` }));

function headerTrackStyle(index: number, track: TrackerTrackData) {
  return {
    left: `${GUTTER_WIDTH_PX + index * trackPitchPx(layout.value.trackCount, layout.value.showExtraEffectColumn)}px`,
    width: `${trackWidthPx(layout.value.trackCount, layout.value.showExtraEffectColumn)}px`,
    '--track-accent': trackAccent(track),
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
 * Device-pixel ceiling on the full-pattern bitmap's backing store. The
 * largest realistic pattern (32 tracks × 256 rows) at DPR 2 would ask for
 * ~794MB of canvas memory, which browsers silently refuse — the context
 * comes back null (or the surface silently fails to rasterize) and the
 * renderer would paint nothing. Above this cap the renderer reports an
 * error instead so the page can fall back to the DOM grid.
 *
 * 64M device px ≈ 256MB RGBA, comfortably under the smallest known canvas
 * area limits. Note this cap is NOT big enough for every pattern: large
 * patterns (e.g. 32 tracks × 256 rows) exceed it on hi-DPI displays
 * (DPR ≳ 1.2), and on overflow the renderer deliberately reports an error
 * so the page falls back to the DOM grid rather than painting nothing.
 */
const MAX_BITMAP_DEVICE_PX = 64 * 1024 * 1024;

function ensureBitmap(cssW: number, cssH: number, scale: number): BitmapSurface | null {
  const w = Math.max(1, Math.ceil(cssW * scale));
  const h = Math.max(1, Math.ceil(cssH * scale));
  if (w * h > MAX_BITMAP_DEVICE_PX) return null;
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
  bitmapCssWidth = cssW;
  bitmapCssHeight = cssH;
  return next;
}

/**
 * Paint the whole pattern into the offscreen bitmap: row-number gutter,
 * then the track grid and selection overlay shifted past it. Repainted on
 * track-array identity, pattern size, selection and theme changes — never
 * per playback row (the overlay owns that).
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
  ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0);
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
  return true;
}

/**
 * Blit the visible slice of the bitmap onto the screen. Runs with an
 * identity transform: blitWindow already speaks device pixels on both
 * sides, so no scaling is applied here.
 */
function paintVisible(): boolean {
  const canvas = visibleCanvasRef.value;
  if (!canvas || viewportW.value <= 0 || viewportH.value <= 0) return true;
  const ctx = canvas.getContext('2d');
  if (!ctx) return failRenderer('pattern-canvas: visible canvas 2D context unavailable');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!bitmap || contentWidth.value <= 0 || totalRowsHeight.value <= 0) return true;
  const win = blitWindow(
    viewTop.value,
    viewLeft.value,
    viewportW.value,
    viewportH.value,
    contentWidth.value,
    totalRowsHeight.value,
    dpr.value,
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
    win.sw,
    win.sh,
  );
  return true;
}

/**
 * The playback bar and editing cursor: everything that moves with the song
 * or the cursor and must not repaint the static bitmap. Cleared and redrawn
 * on playbackRow / active-cell / mode changes only.
 */
function paintOverlay(): boolean {
  const canvas = overlayCanvasRef.value;
  if (!canvas) return true;
  const ctx = canvas.getContext('2d');
  if (!ctx) return failRenderer('pattern-canvas: overlay canvas 2D context unavailable');
  ctx.setTransform(dpr.value, 0, 0, dpr.value, 0, 0);
  ctx.clearRect(0, 0, viewportW.value, viewportH.value);
  // The bar/cursor draw ops speak pattern space (rowY, entryBoxRect) while
  // this canvas is viewport-sized: shift the layer so the gutter stays
  // pinned and the scroll offset lands the ops on the visible rows.
  ctx.save();
  ctx.translate(GUTTER_WIDTH_PX - viewLeft.value, -viewTop.value);
  const theme = getTheme();
  const l = layout.value;
  if (props.playbackRow >= 0 && props.playbackRow < l.rowCount) {
    drawActiveRowBar(ctx, l, theme, {
      playbackRow: props.playbackRow,
      mode: props.playbackMode as PlaybackBarMode,
      trackCount: l.trackCount,
    });
  }
  if (props.activeTrack >= 0 && props.activeColumn >= 0) {
    drawCursorCell(ctx, l, props.tracks, theme, {
      trackIndex: props.activeTrack,
      row: props.selectedRow,
      column: props.activeColumn,
      macroNibble: props.activeMacroNibble,
    });
  }
  ctx.restore();
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
  const drawStatic = wantStatic;
  const drawOverlay = wantOverlay;
  const blit = wantBlit || drawStatic;
  wantStatic = false;
  wantOverlay = false;
  wantBlit = false;
  if (drawStatic && !paintStatic()) return;
  if (blit && !paintVisible()) return;
  if (drawOverlay && !paintOverlay()) return;
}

// ---------------------------------------------------------------------
// Sizing: DPR backing stores, rAF-coalesced ResizeObserver
// ---------------------------------------------------------------------

function applySize(): void {
  const scroller = scrollerRef.value;
  if (!scroller) return;
  const w = scroller.clientWidth;
  const h = scroller.clientHeight;
  const nextDpr = window.devicePixelRatio || 1;
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
  for (const canvas of [visibleCanvasRef.value, overlayCanvasRef.value]) {
    if (!canvas) continue;
    const backingW = Math.max(1, Math.floor(w * nextDpr));
    const backingH = Math.max(1, Math.floor(h * nextDpr));
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW;
      canvas.height = backingH;
    }
  }
  // A backing-store reset clears the layer, so both visible layers always
  // repaint; the static bitmap only rebuilds when the pattern's own extent
  // or the DPR changed (otherwise the blit reuses it as-is).
  schedule(bitmapInputsChanged ? ['static', 'overlay', 'blit'] : ['overlay', 'blit']);
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

function onScrollerScroll(): void {
  const el = scrollerRef.value;
  if (!el) return;
  if (Math.abs(el.scrollTop - viewTop.value) < 0.5) return;
  viewTop.value = el.scrollTop;
  emitScroll();
  // The overlay's pattern→viewport translate reads viewTop/viewLeft, so a
  // scroll must repaint it alongside the blit.
  schedule(['blit', 'overlay']);
}

function onHScroll(): void {
  const el = hscrollRef.value;
  if (!el) return;
  if (Math.abs(el.scrollLeft - viewLeft.value) < 0.5) return;
  viewLeft.value = el.scrollLeft;
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
 * Follow the playback row while playing: keep it a few rows inside the
 * viewport, jumping to roughly a third from the top when it leaves. The
 * native scroll event lands the state back through onScrollerScroll.
 */
function followPlayback(): void {
  if (!props.autoScroll || !props.isPlaying) return;
  const row = props.playbackRow;
  if (row < 0 || row >= props.rows) return;
  const y = rowY(row);
  const top = viewTop.value;
  const viewH = viewportH.value || props.containerHeight;
  const margin = rowPitchPx * 3;
  if (y >= top + margin && y + rowHeightPx <= top + viewH - margin) return;
  const target = Math.max(0, y - (viewH - rowHeightPx) / 3);
  const el = scrollerRef.value;
  if (el) el.scrollTop = target;
  if (Math.abs(viewTop.value - target) >= 0.5) {
    viewTop.value = target;
    emitScroll();
    schedule(['blit']);
  }
}

watch(
  () => [props.playbackRow, props.isPlaying, props.autoScroll, viewportH.value],
  () => {
    followPlayback();
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

function onCanvasMouseDown(e: MouseEvent): void {
  if (e.button !== 0) return;
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
// Lifecycle
// ---------------------------------------------------------------------

onMounted(() => {
  applySize();
  schedule(['static', 'overlay', 'blit']);
  followPlayback();
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
  // same watch as pattern-theme's own observer, plus a repaint.
  themeObserver = new MutationObserver(() => {
    refreshTheme();
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
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
});

defineExpose({ scrollerRef });
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

.canvas-scroller {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden auto;
  scrollbar-width: thin;
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
}

.canvas-hscroll-extent {
  height: 1px;
}
</style>

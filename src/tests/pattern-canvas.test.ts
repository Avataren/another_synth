import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import {
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowPitchPx,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { activeRowBarWidthPx } from 'src/components/tracker/pattern-buffering';
import { hitTest } from 'src/components/tracker/pattern-canvas/pattern-hit-test';
import { blitWindow } from 'src/components/tracker/pattern-canvas/pattern-window';
import { BAND_PAD_PX } from 'src/components/tracker/pattern-canvas/pattern-bands';
import { setCache } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { PatternTheme } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * PatternCanvas component tests (plan §5D).
 *
 * jsdom cannot rasterize: every canvas 2D context is a call-recording mock
 * (same philosophy as pattern-draw.test.ts), the rAF scheduler is a manual
 * pump, and jsdom's always-0 client sizes are patched so the component has a
 * viewport to blit into. Assertions pin the scheduler contract (what gets
 * drawn when), the blit parity with pattern-window's blitWindow, and the
 * pointer-event mapping onto hitTest — not pixels.
 */

// ---------------------------------------------------------------------
// Recording 2D-context mock
// ---------------------------------------------------------------------

interface RectCall {
  op: 'fillRect' | 'strokeRect' | 'clearRect';
  x: number;
  y: number;
  width: number;
  height: number;
}
interface DrawImageCall {
  op: 'drawImage';
  image: unknown;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
}
interface PathCall {
  op: 'path';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}
type CtxCall = RectCall | DrawImageCall | PathCall;

type RecordingCtx = CanvasRenderingContext2D & {
  calls: CtxCall[];
  props: Map<string, unknown>;
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
};

function makeRecordingCtx(): RecordingCtx {
  const calls: CtxCall[] = [];
  const props = new Map<string, unknown>();
  // Transform tracking: draw ops are recorded in viewport space so tests can
  // assert screen coordinates even when the component translates the layer
  // (the overlay paints pattern-space ops through translate()).
  const transformStack: { tx: number; ty: number }[] = [];
  let tx = 0;
  let ty = 0;
  const ctx = {
    canvas: null as HTMLCanvasElement | OffscreenCanvas | null,
    props,
    calls,
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'fillRect', x: x + tx, y: y + ty, width, height });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'strokeRect', x: x + tx, y: y + ty, width, height });
    },
    clearRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'clearRect', x: x + tx, y: y + ty, width, height });
    },
    drawImage(
      image: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
    ) {
      calls.push({ op: 'drawImage', image, sx, sy, sw, sh, dx, dy });
    },
    fillText() {},
    measureText() {
      return { width: 10 };
    },
    save() {
      transformStack.push({ tx, ty });
    },
    restore() {
      const top = transformStack.pop();
      if (top) {
        tx = top.tx;
        ty = top.ty;
      }
    },
    setTransform(_a: number, _b: number, _c: number, _d: number, e: number, f: number) {
      tx = e;
      ty = f;
    },
    translate(dx: number, dy: number) {
      tx += dx;
      ty += dy;
    },
    // Recorded as a path op so tests can assert the rounded playback pill's
    // geometry (translated into viewport space like fillRect above).
    roundRect(
      x: number,
      y: number,
      width: number,
      height: number,
      radius: number,
    ) {
      calls.push({ op: 'path' as const, x: x + tx, y: y + ty, width, height, radius });
    },
    scale() {},
    rotate() {},
    beginPath() {},
    clip() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    arc() {},
    rect() {},
    isPointInPath() {
      return false;
    },
    createLinearGradient() {
      return { addColorStop: () => {} } as unknown as CanvasGradient;
    },
    createRadialGradient() {
      return { addColorStop: () => {} } as unknown as CanvasGradient;
    },
    createPattern() {
      return null;
    },
    getImageData() {
      return { data: new Uint8ClampedArray(4) } as unknown as ImageData;
    },
    putImageData() {},
    drawFocusIfNeeded() {},
  };
  return new Proxy(ctx as unknown as CanvasRenderingContext2D, {
    get(target, key: string) {
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return props.get(key);
    },
    set(target, key: string, value) {
      if (key in target) {
        (target as unknown as Record<string, unknown>)[key] = value;
      } else {
        props.set(key, value);
      }
      return true;
    },
  }) as RecordingCtx;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

/**
 * Install a recording context behind every canvas's getContext. A real
 * canvas returns the *same* context object for repeated getContext('2d')
 * calls (the offscreen bitmap is repainted through one), so contexts are
 * memoized per canvas element.
 */
function stubCanvasContexts(): RecordingCtx[] {
  const contexts: RecordingCtx[] = [];
  const byCanvas = new WeakMap<HTMLCanvasElement, RecordingCtx>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      let ctx = byCanvas.get(this);
      if (!ctx) {
        ctx = makeRecordingCtx();
        ctx.canvas = this;
        byCanvas.set(this, ctx);
        contexts.push(ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    },
  );
  return contexts;
}

// ---------------------------------------------------------------------
// Manual rAF pump
// ---------------------------------------------------------------------

type FrameCallback = (time: number) => void;
const rafQueue = new Map<number, FrameCallback>();
let nextRafId = 1;

type ResizeCallback = (entries: unknown[]) => void;
const resizeCallbacks: ResizeCallback[] = [];

function installFakeRaf(): void {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameCallback) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn((id: number) => {
      rafQueue.delete(id);
    }),
  );
}

/** jsdom has no ResizeObserver; a fake lets tests fire the component's. */
function installFakeResizeObserver(): void {
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn()
      .mockImplementation((cb: ResizeCallback) => {
        resizeCallbacks.push(cb);
        return {
          observe: vi.fn(),
          unobserve: vi.fn(),
          disconnect: vi.fn(),
        };
      }),
  );
}

/** Fire the component's ResizeObserver callback (applySize runs on rAF). */
function fireComponentResize(): void {
  const cb = resizeCallbacks.at(-1);
  expect(cb).toBeDefined();
  cb!([]);
}

/** Run every queued frame once; frames scheduled during the pump wait. */
function pumpFrame(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(performance.now());
}

// ---------------------------------------------------------------------
// Viewport: jsdom elements report clientWidth/clientHeight 0
// ---------------------------------------------------------------------

const VIEWPORT_W = 500;
const VIEWPORT_H = 400;
const realClientWidth = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'clientWidth',
);
const realClientHeight = Object.getOwnPropertyDescriptor(
  Element.prototype,
  'clientHeight',
);

function installViewport(): void {
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => VIEWPORT_W,
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT_H,
  });
}

function restoreViewport(): void {
  if (realClientWidth) {
    Object.defineProperty(Element.prototype, 'clientWidth', realClientWidth);
  }
  if (realClientHeight) {
    Object.defineProperty(Element.prototype, 'clientHeight', realClientHeight);
  }
}

// ---------------------------------------------------------------------
// Theme: the literal fallback palette (jsdom resolves no custom props)
// ---------------------------------------------------------------------

const theme: PatternTheme = {
  entryBase: 'rgba(13, 18, 29, 0.85)',
  entryFilled: 'rgba(21, 31, 48, 0.95)',
  rowSub: 'rgba(13, 18, 29, 0.9)',
  rowBeat: 'rgba(18, 24, 37, 0.95)',
  rowBar: 'rgba(20, 28, 44, 0.98)',
  borderDefault: 'rgba(255, 255, 255, 0.05)',
  borderBeat: 'rgba(255, 255, 255, 0.08)',
  borderBar: 'rgba(77, 242, 197, 0.35)',
  selectedBg: 'rgba(77, 242, 197, 0.12)',
  selectedBorder: 'rgba(77, 242, 197, 0.9)',
  activeBg: 'rgba(77, 242, 197, 0.08)',
  activeBorder: 'rgb(77, 242, 197)',
  accentPrimary: '#4df2c5',
  accentSecondary: 'rgb(88, 176, 255)',
  noteText: '#ffffff',
  instrumentText: 'rgba(255, 255, 255, 0.82)',
  volumeText: '#85b7ff',
  effectText: '#8ef5c5',
  defaultText: '#d8e7ff',
  rowNumberText: '#a7bcd8',
  interpolatedLinear: 'rgba(77, 242, 197, 0.08)',
  interpolatedExponential: 'rgba(158, 197, 255, 0.1)',
  panelBackground: '#0a0e16',
  fontTracker: "'JetBrains Mono', monospace",
};

// ---------------------------------------------------------------------
// Fixtures + mount
// ---------------------------------------------------------------------

/**
 * The custom properties the fixture theme resolves to. Installed as a
 * getComputedStyle stub for every test: the component re-reads :root on
 * mount (a theme flip may have happened while it was unmounted), so the
 * "cascade" must serve the fixture palette. Theme-flip tests mutate this
 * map before mutating :root.
 */
const baseFixtureVars: Record<string, string> = {};
const fixtureVars: Record<string, string> = {
  '--tracker-entry-base': theme.entryBase,
  '--tracker-entry-filled': theme.entryFilled,
  '--tracker-entry-row-sub': theme.rowSub,
  '--tracker-entry-row-beat': theme.rowBeat,
  '--tracker-entry-row-bar': theme.rowBar,
  '--tracker-border-default': theme.borderDefault,
  '--tracker-border-beat': theme.borderBeat,
  '--tracker-border-bar': theme.borderBar,
  '--tracker-selected-bg': theme.selectedBg,
  '--tracker-selected-border': theme.selectedBorder,
  '--tracker-active-bg': theme.activeBg,
  '--tracker-active-border': theme.activeBorder,
  '--tracker-accent-primary': theme.accentPrimary,
  '--tracker-accent-secondary': theme.accentSecondary,
  '--tracker-note-text': theme.noteText,
  '--tracker-instrument-text': theme.instrumentText,
  '--tracker-volume-text': theme.volumeText,
  '--tracker-effect-text': theme.effectText,
  '--tracker-default-text': theme.defaultText,
  '--text-muted': theme.rowNumberText,
  '--tracker-interpolated-linear': theme.interpolatedLinear,
  '--tracker-interpolated-exponential': theme.interpolatedExponential,
  '--panel-background': theme.panelBackground,
  '--font-tracker': theme.fontTracker,
};
Object.assign(baseFixtureVars, fixtureVars);
let computedStub: ReturnType<typeof stubComputedVars> | null = null;

function makeTrack(id: string, rowCount = 32, note = 'C-4'): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: rowCount }, (_, i) => ({ row: i, note })),
  };
}

/**
 * An edited copy of `track` sharing every entry object except `row`, where
 * a fresh object replaces the old — exactly what updateEntryAt produces.
 */
function editedTrack(track: TrackerTrackData, row: number, note = 'D-5'): TrackerTrackData {
  return {
    ...track,
    entries: track.entries.map((entry) => (entry.row === row ? { ...entry, row, note } : entry)),
  };
}

function mountCanvas(opts: {
  tracks?: TrackerTrackData[];
  rows?: number;
  scrollTop?: number;
  scrollLeft?: number;
  playbackRow?: number;
  playbackMode?: 'pattern' | 'song';
  autoScroll?: boolean;
  isPlaying?: boolean;
  reserveSideGutter?: boolean;
  containerWidth?: number;
  granularScroll?: boolean;
} = {}) {
  return mount(PatternCanvas, {
    props: {
      tracks: opts.tracks ?? [makeTrack('t0'), makeTrack('t1')],
      rows: opts.rows ?? 32,
      selectedRow: 0,
      playbackRow: opts.playbackRow ?? 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: opts.autoScroll ?? false,
      isPlaying: opts.isPlaying ?? false,
      playbackMode: opts.playbackMode ?? 'pattern',
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: opts.scrollTop ?? 0,
      scrollLeft: opts.scrollLeft ?? 0,
      containerWidth: opts.containerWidth ?? VIEWPORT_W,
      containerHeight: VIEWPORT_H,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: opts.reserveSideGutter ?? false,
      // exactOptionalPropertyTypes: the key is either absent or a boolean.
      ...(opts.granularScroll === undefined ? {} : { granularScroll: opts.granularScroll }),
    },
  });
}

type MountedCanvas = ReturnType<typeof mountCanvas>;

let contexts: RecordingCtx[] = [];

beforeEach(() => {
  document.documentElement.style.removeProperty('--theme-flip-seq');
  vi.unstubAllGlobals();
  rafQueue.clear();
  resizeCallbacks.length = 0;
  installFakeRaf();
  installFakeResizeObserver();
  installViewport();
  setCache(theme);
  computedStub = stubComputedVars(fixtureVars);
  contexts = stubCanvasContexts();
});

afterEach(() => {
  computedStub?.mockRestore();
  computedStub = null;
  for (const key of Object.keys(fixtureVars)) delete fixtureVars[key];
  Object.assign(fixtureVars, baseFixtureVars);
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  restoreViewport();
  vi.unstubAllGlobals();
  setCache(null);
});

// ---------------------------------------------------------------------
// Handles onto the three canvases the component paints
// ---------------------------------------------------------------------

function layerCanvases(wrapper: MountedCanvas) {
  const layers = wrapper.findAll('canvas.canvas-layer');
  return {
    visible: layers[0]!.element as HTMLCanvasElement,
    overlay: layers[1]!.element as HTMLCanvasElement,
  };
}

/** The offscreen full-pattern bitmap: the newest canvas that is not on screen. */
function bitmapOf(wrapper: MountedCanvas) {
  const { visible, overlay } = layerCanvases(wrapper);
  // Append-only list: a DPR/extent change allocates a new bitmap, which is
  // the current one — scan from the end.
  const entry = [...contexts]
    .reverse()
    .find((c) => c.canvas !== visible && c.canvas !== overlay);
  expect(entry).toBeDefined();
  expect(entry!.canvas).toBeDefined();
  return entry!;
}

const drawImageOn = (ctx: RecordingCtx) =>
  ctx.calls.filter((call): call is DrawImageCall => call.op === 'drawImage');
const fillsOn = (ctx: RecordingCtx) =>
  ctx.calls.filter(
    (call): call is RectCall => call.op === 'fillRect',
  );
const pathsOn = (ctx: RecordingCtx) =>
  ctx.calls.filter((call): call is PathCall => call.op === 'path');

function mockCanvasRect(el: HTMLCanvasElement): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: VIEWPORT_W,
    bottom: VIEWPORT_H,
    width: VIEWPORT_W,
    height: VIEWPORT_H,
    toJSON: () => ({}),
  } as DOMRect);
}

function dispatchMouse(
  target: EventTarget,
  type: 'mousedown' | 'mousemove' | 'mouseup',
  x: number,
  y: number,
): void {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }),
  );
}

/**
 * jsdom has no TouchEvent; the handlers only read touches[0],
 * changedTouches[0], cancelable and timeStamp, so a plain Event with those
 * pinned on stands in for one.
 */
function dispatchTouch(
  target: EventTarget,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  x: number,
  y: number,
  timeStamp: number,
  remaining = 0,
): void {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as unknown as TouchEvent;
  const point = { clientX: x, clientY: y, identifier: 0 };
  const ended = type === 'touchend' || type === 'touchcancel';
  // On end events e.touches holds the fingers still on the screen; handlers
  // read only its length there, so placeholder points stand in for them.
  const stillDown = ended
    ? Array.from({ length: remaining }, (_, i) => ({ ...point, identifier: i }))
    : [point];
  Object.defineProperty(event, 'touches', { value: stillDown });
  Object.defineProperty(event, 'changedTouches', { value: [point] });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  target.dispatchEvent(event);
}

/** jsdom does not fire scroll on scrollTop writes; the test plays the browser. */
function fireScroll(el: HTMLElement): void {
  el.dispatchEvent(new Event('scroll'));
}

/**
 * jsdom does no layout: scrollHeight/scrollWidth are 0, so maxScrollTop()
 * and maxScrollLeft() would clamp every pan to 0. Pin the extents the
 * spacer and the hscroll extent define in a real browser.
 */
function installScrollExtents(wrapper: MountedCanvas): void {
  const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
  const hscroll = wrapper.find('.canvas-hscroll').element as HTMLElement;
  Object.defineProperty(scroller, 'scrollHeight', {
    value: 32 * rowPitchPx,
    configurable: true,
  });
  Object.defineProperty(hscroll, 'scrollWidth', {
    value: GUTTER_WIDTH_PX + totalTracksWidth(2, false),
    configurable: true,
  });
}

// ---------------------------------------------------------------------
// Mount / DOM structure
// ---------------------------------------------------------------------

describe('mount (not playing)', () => {
  it('renders the DOM header strip and the two canvas layers', () => {
    const wrapper = mountCanvas();
    expect(wrapper.find('.canvas-header').exists()).toBe(true);
    expect(wrapper.findAll('.header-track')).toHaveLength(2);
    expect(wrapper.find('.header-track-name').text()).toBe('Track t0');
    expect(wrapper.find('.header-row-label').text()).toBe('Row');
    expect(wrapper.findAll('canvas.canvas-layer')).toHaveLength(2);
    expect(wrapper.find('.canvas-spacer').exists()).toBe(true);
    wrapper.unmount();
  });

  it('getContext returning null emits rendererError exactly once', async () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const wrapper = mountCanvas();
    await pumpFrame();
    const errors = wrapper.emitted('rendererError');
    expect(errors).toHaveLength(1);
    const error = (errors![0] as unknown[])[0] as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/2D context unavailable/i);
    // A later scroll still fails but never re-emits: one-shot error path.
    await wrapper.setProps({ scrollTop: 10 });
    await pumpFrame();
    expect(wrapper.emitted('rendererError')).toHaveLength(1);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Scheduler: the rAF pump fires the requested draws
// ---------------------------------------------------------------------

describe('draw scheduling', () => {
  it('a rAF pump flushes the frame requested on mount', async () => {
    const wrapper = mountCanvas();
    expect(rafQueue.size).toBe(1); // one coalesced frame, nothing running
    pumpFrame();
    expect(rafQueue.size).toBe(0);
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    // The blit pipeline ran: clear the layer, then draw the bitmap slice.
    expect(viewCtx.calls.some((call) => call.op === 'clearRect')).toBe(true);
    expect(drawImageOn(viewCtx).length).toBe(1);
    wrapper.unmount();
  });

  it('props arriving before the pump coalesce into one frame', async () => {
    const wrapper = mountCanvas();
    const framesBefore = rafQueue.size;
    await wrapper.setProps({ playbackRow: 3 });
    await nextTick();
    await wrapper.setProps({ selectedRow: 3 });
    await nextTick();
    expect(rafQueue.size).toBe(framesBefore); // still the same queued frame
    pumpFrame();
    expect(rafQueue.size).toBe(0);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Panel width: min-width behavior, centering, scrollbar only on overflow
// ---------------------------------------------------------------------

describe('panel width (min-width + centered)', () => {
  it('binds the panel to the pattern content width, not the viewport', () => {
    const wrapper = mountCanvas({ containerWidth: VIEWPORT_W });
    const root = wrapper.find('.pattern-canvas');
    // Two full-width tracks + gap + the 78px row gutter, plus 38px chrome.
    const expected = GUTTER_WIDTH_PX + totalTracksWidth(2, false) + 38;
    expect(root.attributes('style')).toContain(`--panel-width: ${expected}px`);
    // The bug: the panel filled the whole available width. A narrow song in
    // a wide viewport must stay at its natural width so the page can center
    // it with spectrum-analyser room around it.
    expect(expected).toBeLessThan(VIEWPORT_W);
    wrapper.unmount();
  });

  it('follows the pattern content width when tracks are added', async () => {
    const wrapper = mountCanvas({ containerWidth: 4000 });
    const before = GUTTER_WIDTH_PX + totalTracksWidth(2, false) + 38;
    expect(wrapper.find('.pattern-canvas').attributes('style')).toContain(
      `--panel-width: ${before}px`,
    );
    const added = [makeTrack('x'), makeTrack('y'), makeTrack('z')];
    await wrapper.setProps({ tracks: [...(wrapper.props('tracks') as TrackerTrackData[]), ...added] });
    await nextTick();
    const after = GUTTER_WIDTH_PX + totalTracksWidth(5, false) + 38;
    expect(wrapper.find('.pattern-canvas').attributes('style')).toContain(
      `--panel-width: ${after}px`,
    );
    wrapper.unmount();
  });

  it('reserves the analyser gutter only when the analyser is on', () => {
    const withGutter = mountCanvas({ reserveSideGutter: true });
    expect(withGutter.find('.pattern-canvas').attributes('style')).toContain(
      '--tracker-side-gutter: 180px',
    );
    withGutter.unmount();

    const without = mountCanvas({ reserveSideGutter: false });
    expect(without.find('.pattern-canvas').attributes('style')).toContain(
      '--tracker-side-gutter: 0px',
    );
    without.unmount();
  });

  it('hides the horizontal scrollbar when the content fits the viewport', () => {
    // containerWidth 600 → 564 available inside .pattern-area's padding;
    // the 2-track panel (486px incl. chrome) fits, so no scrollbar.
    const wrapper = mountCanvas({ containerWidth: 600 });
    expect(wrapper.find('.canvas-hscroll').isVisible()).toBe(false);
    wrapper.unmount();
  });

  it('shows the proxy scrollbar only when the capped panel clips tracks', () => {
    // 24 tightened tracks (160px + 6px gap): panel 4094px ≫ 464 available —
    // the page caps the panel and the scroller scrolls the overflow.
    const many = Array.from({ length: 24 }, (_, i) => makeTrack(`t${i}`, 4));
    const wrapper = mountCanvas({ tracks: many, rows: 4 });
    expect(wrapper.find('.canvas-hscroll').isVisible()).toBe(true);
    wrapper.unmount();
  });

  it('shows the scrollbar when the analyser reserve squeezes a narrow viewport', () => {
    // 2 tracks (486px panel) vs 464 available minus 2×69.6 reserved gutters
    // (15% cap): the capped panel cannot show all tracks, so scroll.
    const wrapper = mountCanvas({ reserveSideGutter: true, containerWidth: VIEWPORT_W });
    expect(wrapper.find('.canvas-hscroll').isVisible()).toBe(true);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Vertical playback scroll: one row per step, DOM-grid parity
// ---------------------------------------------------------------------

describe('playback follow (row-granular auto-scroll)', () => {
  /** jsdom stores scrollTop writes verbatim. The follow's DOM write happens
   *  inside the coalesced rAF frame, so pump one before asserting. */
  function scrollerOf(wrapper: MountedCanvas): HTMLElement {
    return wrapper.find('.canvas-scroller').element as HTMLElement;
  }

  it('centers the playing row in the first frame after mount', () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    // The follow runs inside the rAF frame (never synchronously on mount).
    pumpFrame();
    const expected = Math.max(0, 10 * rowPitchPx - (VIEWPORT_H - rowHeightPx) / 2);
    expect(scrollerOf(wrapper).scrollTop).toBe(expected);
    // The auto-scroll reports itself to the page state.
    expect(wrapper.emitted('scroll')).toEqual([[{ top: expected, left: 0 }]]);
    wrapper.unmount();
  });

  it('advances exactly one row pitch per playback step', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = scrollerOf(wrapper);
    const start = scroller.scrollTop as number;
    expect(start).toBeGreaterThan(0);

    await wrapper.setProps({ playbackRow: 11 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start + rowPitchPx);

    await wrapper.setProps({ playbackRow: 12 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start + 2 * rowPitchPx);
    wrapper.unmount();
  });

  it('does not scroll when auto-scroll is off', async () => {
    const wrapper = mountCanvas({ autoScroll: false, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = scrollerOf(wrapper);
    expect(scroller.scrollTop).toBe(0);
    expect(wrapper.emitted('scroll')).toBeUndefined();

    await wrapper.setProps({ playbackRow: 11 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(0);
    wrapper.unmount();
  });

  it('starts following only once isPlaying turns on', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: false, playbackRow: 10 });
    pumpFrame();
    expect(scrollerOf(wrapper).scrollTop).toBe(0);

    await wrapper.setProps({ isPlaying: true });
    await nextTick();
    pumpFrame();
    const expected = Math.max(0, 10 * rowPitchPx - (VIEWPORT_H - rowHeightPx) / 2);
    expect(scrollerOf(wrapper).scrollTop).toBe(expected);
    wrapper.unmount();
  });

  it('writes scrollTop only inside the rAF frame, never synchronously', async () => {
    // The playback-row adoption must be rAF-coalesced: after the prop change
    // but before the frame, the scroller is untouched; the frame applies it.
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const before = scrollerOf(wrapper).scrollTop;

    await wrapper.setProps({ playbackRow: 11 });
    await nextTick();
    expect(scrollerOf(wrapper).scrollTop).toBe(before); // no frame ran yet
    pumpFrame();
    expect(scrollerOf(wrapper).scrollTop).toBe(before + rowPitchPx);
    wrapper.unmount();
  });

  it('defaults to granular (one row per step) when the prop is unset', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = scrollerOf(wrapper);
    const start = scroller.scrollTop as number;

    await wrapper.setProps({ playbackRow: 11 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start + rowPitchPx);
    wrapper.unmount();
  });

  it('with granularScroll=false, pages instead of following every row', async () => {
    // The granularPlaybackScroll preference off: the view only re-anchors
    // once the playing row leaves a 3-row margin, then jumps it a third of
    // the way down — coarse paging that stays silent for small steps.
    const wrapper = mountCanvas({
      autoScroll: true,
      isPlaying: true,
      playbackRow: 10,
      granularScroll: false,
    });
    pumpFrame();
    const scroller = scrollerOf(wrapper);
    const start = scroller.scrollTop as number;
    expect(start).toBeGreaterThan(0); // centered once on the first frame

    // Rows 11..13 stay inside the margin window: no scroll at all.
    await wrapper.setProps({ playbackRow: 11 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start);

    await wrapper.setProps({ playbackRow: 12 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start);

    await wrapper.setProps({ playbackRow: 13 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start);

    // Row 14 crosses the bottom margin (start + 3*36 + 30 > start + viewH −
    // 108), so the view re-anchors — a larger jump, not one pitch.
    await wrapper.setProps({ playbackRow: 14 });
    await nextTick();
    pumpFrame();
    const jumped = scroller.scrollTop as number;
    expect(jumped).toBeGreaterThan(start);
    expect(jumped).not.toBe(start + rowPitchPx);
    // The jump targets a third from the top, per the paged mode.
    const expected = 14 * rowPitchPx - (VIEWPORT_H - rowHeightPx) / 3;
    expect(jumped).toBeCloseTo(expected, 5);
    wrapper.unmount();
  });

  it('re-enabling granularScroll resumes one-row-per-step', async () => {
    const wrapper = mountCanvas({
      autoScroll: true,
      isPlaying: true,
      playbackRow: 10,
      granularScroll: false,
    });
    pumpFrame();
    const scroller = scrollerOf(wrapper);

    await wrapper.setProps({ granularScroll: true, playbackRow: 11 });
    await nextTick();
    pumpFrame();
    const start = scroller.scrollTop as number;

    await wrapper.setProps({ playbackRow: 12 });
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(start + rowPitchPx);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Static bitmap repaints
// ---------------------------------------------------------------------

describe('static bitmap repaints', () => {
  it('a tracks identity change repaints the static bitmap from scratch', async () => {
    const wrapper = mountCanvas();
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const staticFillsBefore = fillsOn(bitmap).length;
    expect(staticFillsBefore).toBeGreaterThan(0);

    await wrapper.setProps({ tracks: [makeTrack('a'), makeTrack('b')] });
    await nextTick();
    pumpFrame();

    // Cleared and repainted: exactly one more full static paint.
    expect(fillsOn(bitmap).length).toBe(staticFillsBefore * 2);
    wrapper.unmount();
  });
});

describe('overlay on playbackRow change', () => {
  it('redraws the overlay only, never the static bitmap', async () => {
    const wrapper = mountCanvas({ playbackRow: 0, playbackMode: 'pattern' });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const staticFillsBefore = fillsOn(bitmap).length;
    const overlayPathsBefore = pathsOn(overlayCtx).length;
    expect(overlayPathsBefore).toBeGreaterThan(0); // the two playback pills

    await wrapper.setProps({ playbackRow: 4 });
    await nextTick();
    pumpFrame();

    expect(fillsOn(bitmap).length).toBe(staticFillsBefore);
    // The pills were cleared and redrawn on the new row.
    expect(pathsOn(overlayCtx).length).toBeGreaterThan(overlayPathsBefore);
    wrapper.unmount();
  });

  it('translates the overlay by gutter − scrollLeft and −scrollTop', async () => {
    const scrollTop = 72;
    const scrollLeft = 30;
    const wrapper = mountCanvas({ scrollTop, scrollLeft, playbackRow: 2 });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;

    const bar = pathsOn(overlayCtx)
      .filter((c) => c.height === rowHeightPx)
      .find((c) => c.width === activeRowBarWidthPx(2, false));
    expect(bar).toBeDefined();
    // rowY(2) − scrollTop, not rowY(2): the bar lands in viewport space,
    // pinned past the gutter minus the horizontal scroll.
    expect(bar!.y).toBeCloseTo(2 * rowPitchPx - scrollTop, 5);
    expect(bar!.x).toBeCloseTo(GUTTER_WIDTH_PX - scrollLeft, 5);
    wrapper.unmount();
  });

  it('a native scroller scroll repaints the overlay in the new viewport space', async () => {
    const wrapper = mountCanvas({ playbackRow: 2 });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;

    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true });
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    pumpFrame();

    // Without the overlay in the scroll schedule the bar would still sit at
    // its pattern-space y and drift off the visible rows. (Calls accumulate
    // across frames — take the newest pill, painted after the scroll.)
    const bar = pathsOn(overlayCtx)
      .filter((c) => c.height === rowHeightPx)
      .filter((c) => c.width === activeRowBarWidthPx(2, false))
      .at(-1);
    expect(bar).toBeDefined();
    expect(bar!.y).toBeCloseTo(2 * rowPitchPx - 180, 5);
    wrapper.unmount();
  });
});

describe('playback follow: one coalesced frame per row advance', () => {
  it('a row advance blits once and repaints the overlay in bands only — no full-layer clear, no double paint', async () => {
    // The 2026-09-04 round-2 report: flicker during PLAYBACK, not just pan.
    // This pins the frame plumbing the follow path actually runs: the row
    // watcher's ['overlay'] schedule and the follow's view move coalesce
    // into ONE rAF frame (runFrame reads the view origin once, after
    // applyFollow), and the follow's own scrollTop write self-echoes
    // through the scroller's scroll event without scheduling a second
    // frame. So per row advance: exactly one blit, band-only overlay
    // clears. If this ever double-paints or full-clears, playback flicker
    // has a code-level cause again; as of D103 it does not.
    const wrapper = mountCanvas({ playbackRow: 10, isPlaying: true, autoScroll: true });
    pumpFrame(); // mount frame: the one legitimate full paint
    const { visible, overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const viewCtx = contexts.find((c) => c.canvas === visible)!;

    for (const row of [11, 12]) {
      const blitsBefore = viewCtx.calls.filter((c) => c.op === 'drawImage').length;
      await wrapper.setProps({ playbackRow: row } as never);
      await nextTick();
      const overlayFrameStart = overlayCtx.calls.length;
      pumpFrame();

      // Exactly one blit: the follow moved the view (row 11 target =
      // 11·36 − (400−30)/2 = 211, inside the 752px scroll extent), and the
      // scroll event self-echo scheduled nothing.
      expect(viewCtx.calls.filter((c) => c.op === 'drawImage').length).toBe(blitsBefore + 1);
      // The new blit reads the row-advanced view (row 11 centers at 211),
      // from the same frame that repainted the overlay — single-frame
      // composition holds on the playback path too.
      const newestBlit = viewCtx.calls
        .filter((c) => c.op === 'drawImage')
        .at(-1) as unknown as { sy: number };
      expect(newestBlit.sy).toBeCloseTo(row * rowPitchPx - (VIEWPORT_H - rowHeightPx) / 2, 5);

      // Overlay: bands only — every clear is one row-band tall, never the
      // whole layer (VIEWPORT_H = 400 would be a full clear).
      const clears = overlayCtx.calls
        .slice(overlayFrameStart)
        .filter((call): call is RectCall => call.op === 'clearRect');
      expect(clears.length).toBeGreaterThan(0);
      for (const clear of clears) {
        expect(clear.height).toBeLessThanOrEqual(rowHeightPx + 2 * BAND_PAD_PX + 0.5);
      }
      // And the pills were repainted on the new row, once.
      expect(newestPills(overlayCtx, overlayFrameStart)).toHaveLength(2);
    }
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Follow vs. pan: the user owns the view during a touch gesture
// ---------------------------------------------------------------------

/**
 * The 2026-09-04 round-3 report: while playing and panning, one frame (or
 * so) painted the indicator/grid at the CENTER-wrong position. Trace: the
 * row watcher flags pendingFollow; the next rAF's applyFollow() had no
 * touch awareness and wrote el.scrollTop = center + viewTop = center, and
 * that SAME frame painted it; the next touchmove restored the pan (panTarget
 * computes from the touchstart origin, so it overwrites the follow write
 * wholesale). Fix: while a touch pan or fling owns the view — and for a
 * grace period after — follow does not write; the next playbackRow change
 * after the gesture re-centers (the DOM grid's follow rule).
 */
describe('follow vs. pan (the user owns the view mid-gesture)', () => {
  /** Follow center target for a row at VIEWPORT_H = 400. */
  const centerOf = (row: number) =>
    Math.min(Math.max(0, row * rowPitchPx - (VIEWPORT_H - rowHeightPx) / 2), 32 * rowPitchPx - VIEWPORT_H);

  let nowMs: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    nowMs = 1000;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  function panView(wrapper: MountedCanvas, fromTop: number, dy: number): number {
    installScrollExtents(wrapper);
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    dispatchTouch(canvas, 'touchstart', 100, 200, nowMs);
    nowMs += 50;
    dispatchTouch(canvas, 'touchmove', 100, 200 + dy, nowMs);
    fireScroll(scroller);
    return fromTop - dy;
  }

  it('a row advance during an active pan never paints the follow-center view', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame(); // mount: follow centers row 10
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    expect(scroller.scrollTop).toBe(centerOf(10)); // sanity: follow ran

    // Finger lands and pans 60px: the view is the user's now.
    const panTop = panView(wrapper, centerOf(10), 60);
    await nextTick();
    pumpFrame(); // paints the pan view
    expect(scroller.scrollTop).toBe(panTop);

    // Playback advances a row WHILE the finger is still down. The follow
    // must not write — and the frame must not paint — the center position.
    await wrapper.setProps({ playbackRow: 11 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(panTop);
    expect(drawImageOn(viewCtx).at(-1)!.sy).toBeCloseTo(panTop, 5);

    // The pan continues; the next frame paints the pan view, not a snap-back.
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    nowMs += 50;
    dispatchTouch(canvas, 'touchmove', 100, 270, nowMs);
    fireScroll(scroller);
    await nextTick();
    pumpFrame();
    expect(drawImageOn(viewCtx).at(-1)!.sy).toBeCloseTo(panTop - 10, 5);
    wrapper.unmount();
  });

  it('follow stays off through the post-gesture grace, then resumes at the next row change', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const panTop = panView(wrapper, centerOf(10), 60);
    await nextTick();
    pumpFrame();

    // Lift without a throw: the release is long after the last move, so no
    // fling — but the grace period still owns the view briefly.
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    nowMs += 300; // 300ms after the move: inside the 350ms grace
    dispatchTouch(canvas, 'touchend', 100, 260, nowMs);

    await wrapper.setProps({ playbackRow: 11 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(panTop); // grace: no snap

    // Once the grace is gone, the NEXT row change re-centers — the DOM
    // grid's follow rule (center on every row change while playing).
    nowMs += 500;
    await wrapper.setProps({ playbackRow: 12 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(centerOf(12));
    wrapper.unmount();
  });

  it('catching a coasting fling keeps ownership past the grace while the finger holds', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const followTarget = centerOf(11);
    installScrollExtents(wrapper);

    // Launch a throw (two moves 16ms apart, released mid-motion).
    dispatchTouch(canvas, 'touchstart', 100, 200, nowMs);
    dispatchTouch(canvas, 'touchmove', 100, 230, nowMs + 16);
    dispatchTouch(canvas, 'touchmove', 100, 260, nowMs + 32);
    fireScroll(scroller);
    nowMs += 40;
    dispatchTouch(canvas, 'touchend', 100, 260, nowMs); // vy ≈ −1.875 px/ms

    // Catch the coast: a finger lands while it runs, then HOLDS still far
    // past the 350ms grace. The view stays the user's the whole time.
    nowMs += 100;
    dispatchTouch(canvas, 'touchstart', 100, 260, nowMs);
    nowMs += 1000;
    await wrapper.setProps({ playbackRow: 11 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).not.toBe(followTarget);
    expect(drawImageOn(viewCtx).at(-1)!.sy).not.toBeCloseTo(followTarget, 5);
    wrapper.unmount();
  });

  it('a second finger lifting while the first stays down keeps ownership', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    const panTop = centerOf(10) - 60;
    installScrollExtents(wrapper);

    dispatchTouch(canvas, 'touchstart', 100, 200, nowMs);
    nowMs += 50;
    dispatchTouch(canvas, 'touchmove', 100, 260, nowMs);
    fireScroll(scroller);
    await nextTick();
    pumpFrame();

    // The second finger lifts well after the last move (a stop, not a
    // throw -- the component reads any touchend's samples as a release);
    // the first finger stays on the glass.
    nowMs += 300;
    dispatchTouch(canvas, 'touchend', 100, 260, nowMs, 1);
    nowMs += 1000; // well past the grace, first finger still down
    await wrapper.setProps({ playbackRow: 11 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(panTop); // no center write under the finger

    // The last finger lifts: grace runs, then the next row change re-centers.
    nowMs += 100;
    dispatchTouch(canvas, 'touchend', 100, 260, nowMs);
    nowMs += 500;
    await wrapper.setProps({ playbackRow: 12 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(centerOf(12));
    wrapper.unmount();
  });

  it('an active fling holds follow off until the coast stops', async () => {
    const wrapper = mountCanvas({ autoScroll: true, isPlaying: true, playbackRow: 10 });
    pumpFrame();
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const canvas = wrapper.findAll('canvas.canvas-layer')[1]!.element;
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const followTarget = centerOf(11);
    installScrollExtents(wrapper);

    // A fast upward throw: two moves 16ms apart, released mid-motion.
    dispatchTouch(canvas, 'touchstart', 100, 200, nowMs);
    dispatchTouch(canvas, 'touchmove', 100, 230, nowMs + 16);
    dispatchTouch(canvas, 'touchmove', 100, 260, nowMs + 32);
    fireScroll(scroller);
    nowMs += 40;
    dispatchTouch(canvas, 'touchend', 100, 260, nowMs); // vy ≈ −1.875 px/ms

    // Row advance while the coast is running: the follow must not write —
    // neither the scroller NOR the paint. (The scrollTop assertion alone is
    // blind on main: the fling step queued after the follow frame overwrites
    // the write; the PAINTED view is what flashed for Morten.)
    await wrapper.setProps({ playbackRow: 11 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).not.toBe(followTarget);
    expect(drawImageOn(viewCtx).at(-1)!.sy).not.toBeCloseTo(followTarget, 5);

    // Coast to a stop (decay 0.94/frame from ≈1.875 needs ~75 frames), let
    // the grace pass, and the next row change re-centers.
    for (let i = 0; i < 120; i++) {
      nowMs += 16;
      pumpFrame();
    }
    nowMs += 500;
    await wrapper.setProps({ playbackRow: 12 } as never);
    await nextTick();
    pumpFrame();
    expect(scroller.scrollTop).toBe(centerOf(12));
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Scroll → blit parity with blitWindow
// ---------------------------------------------------------------------

describe('scroll prop → blit window', () => {
  it('drawImage args match blitWindow(scrollTop, scrollLeft, ...)', async () => {
    const wrapper = mountCanvas({ scrollTop: 0, scrollLeft: 0 });
    pumpFrame();
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;

    const scrollTop = 72;
    const scrollLeft = 30;
    await wrapper.setProps({ scrollTop, scrollLeft });
    await nextTick();
    pumpFrame();

    const bitmap = bitmapOf(wrapper);
    // Two full-width tracks (180px) + one 10px gap + the 78px gutter.
    const contentWidth = GUTTER_WIDTH_PX + totalTracksWidth(2, false);
    const totalRowsHeight = 32 * rowPitchPx;
    const expected = blitWindow(
      scrollTop,
      scrollLeft,
      VIEWPORT_W,
      VIEWPORT_H,
      contentWidth,
      totalRowsHeight,
      window.devicePixelRatio || 1,
    );
    const blit = drawImageOn(viewCtx).at(-1)!;
    expect(blit.image).toBe(bitmap.canvas);
    expect(blit.sx).toBeCloseTo(expected.sx, 5);
    expect(blit.sy).toBeCloseTo(expected.sy, 5);
    expect(blit.sw).toBeCloseTo(expected.sw, 5);
    expect(blit.sh).toBeCloseTo(expected.sh, 5);
    expect(blit.dx).toBeCloseTo(expected.dx, 5);
    expect(blit.dy).toBeCloseTo(expected.dy, 5);
    wrapper.unmount();
  });

  it('a native scroller scroll event also runs the blit pipeline', async () => {
    const wrapper = mountCanvas({ scrollTop: 0 });
    pumpFrame();
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const blitsBefore = drawImageOn(viewCtx).length;

    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true });
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    pumpFrame();

    expect(drawImageOn(viewCtx).length).toBe(blitsBefore + 1);
    expect(drawImageOn(viewCtx).at(-1)!.sy).toBeCloseTo(180, 5);
    // The internal scroll reports itself back to the page.
    expect(wrapper.emitted('scroll')).toEqual([[{ top: 180, left: 0 }]]);
    wrapper.unmount();
  });

  it('an echoed prop value equal to the last emission is not forced back into the scroller', async () => {
    const wrapper = mountCanvas({ scrollTop: 0 });
    pumpFrame();
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const blitsBefore = drawImageOn(viewCtx).length;

    // The user scrolls natively; the component reports 180 to the page.
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 180, configurable: true });
    scroller.dispatchEvent(new Event('scroll'));
    await nextTick();
    pumpFrame();
    expect(wrapper.emitted('scroll')).toEqual([[{ top: 180, left: 0 }]]);

    // The page echoes 180 back while the user has already kept scrolling to
    // 240: the self-echo must be dropped, not forced into the scroller.
    Object.defineProperty(scroller, 'scrollTop', { value: 240, configurable: true });
    await wrapper.setProps({ scrollTop: 180 });
    await nextTick();
    expect(scroller.scrollTop).toBe(240);
    expect(drawImageOn(viewCtx).length).toBe(blitsBefore + 1); // no extra blit
    wrapper.unmount();
  });

  it('a genuinely external scroll prop still resyncs the scroller', async () => {
    const wrapper = mountCanvas({ scrollTop: 0 });
    pumpFrame();
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    Object.defineProperty(scroller, 'scrollTop', { value: 0, writable: true, configurable: true });

    await wrapper.setProps({ scrollTop: 90 });
    await nextTick();
    expect(scroller.scrollTop).toBe(90);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Theme flip: the canvas grid must follow the active style/theme
// ---------------------------------------------------------------------

/** jsdom resolves no custom props; these are the values a flip produces. */
const flippedPalette: Record<string, string> = {
  '--tracker-entry-base': 'rgba(20, 15, 10, 0.85)',
  '--tracker-entry-filled': 'rgba(30, 24, 18, 0.95)',
  '--panel-background': '#1a1610',
  '--tracker-accent-primary': 'rgb(255, 180, 80)',
  '--tracker-effect-text': '#ffa850',
  '--text-muted': '#c8a878',
};

function stubComputedVars(map: Record<string, string>) {
  // Same object reference is kept: the test mutates `map` after mount and
  // the stub sees the flip, like a real :root style rewrite would. A proxy
  // over the real computed style keeps every other accessor (display,
  // visibility, … used by test-utils' isVisible) working.
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
    const style = real(el);
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'getPropertyValue') {
          return (name: string) => map[name] ?? target.getPropertyValue(name);
        }
        return Reflect.get(target, prop);
      },
    }) as CSSStyleDeclaration;
  });
}
/** A :root style write — the MutationObserver trigger applyTheme uses. */
let flipSeq = 0;
function flipTheme(): void {
  // A fresh value every time: an identical setProperty does not change the
  // style attribute, so it produces no mutation record to observe.
  flipSeq += 1;
  document.documentElement.style.setProperty('--theme-flip-seq', String(flipSeq));
}

/**
 * Pump frames across a few macrotasks until `pred` holds. jsdom delivers
 * MutationObserver callbacks on its own schedule (not always before the
 * next macrotask), so the observed repaint is awaited behaviorally instead
 * of assuming a delivery tick.
 */
async function pumpUntil(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 10 && !pred(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    pumpFrame();
  }
}

describe('theme flip repaints', () => {
  it('a theme flip repaints the static bitmap with the new palette', async () => {
    try {
      const wrapper = mountCanvas();
      pumpFrame();
      const bitmap = bitmapOf(wrapper);
      const fillsBefore = fillsOn(bitmap).length;
      expect(fillsBefore).toBeGreaterThan(0);

      // New palette values + the :root style write the observer watches.
      Object.assign(fixtureVars, flippedPalette);
      flipTheme();
      await pumpUntil(() => fillsOn(bitmap).length > fillsBefore);

      // A full repaint happened (the incremental diff path sees no content
      // change and would otherwise keep the old palette on the bitmap).
      expect(fillsOn(bitmap).length).toBe(fillsBefore * 2);
      wrapper.unmount();
    } finally {
      // afterEach restores fixtureVars
    }
  });

  it('a flip while unmounted is picked up on remount (route navigation)', async () => {
    try {
      // Visit the canvas page, leave, flip the theme in settings, come back.
      const first = mountCanvas();
      pumpFrame();
      first.unmount();

      Object.assign(fixtureVars, flippedPalette);
      flipTheme(); // the flip happens while nothing observes :root

      const wrapper = mountCanvas();
      pumpFrame();
      const bitmap = bitmapOf(wrapper);
      expect(fillsOn(bitmap).length).toBeGreaterThan(0);
      // The remount painted with the NEW palette: the last cell fill of the
      // static paint uses the flipped effect text, not the stale cache's.
      expect(bitmap.props.get('fillStyle')).toBe(flippedPalette['--tracker-effect-text']);
      wrapper.unmount();
    } finally {
      // afterEach restores fixtureVars
    }
  });

  it('a theme flip repaints the pre-rendered upcoming pattern too', async () => {
    try {
      const upcoming = { id: 'p2', tracks: [makeTrack('u'), makeTrack('v')], rows: 32 };
      const wrapper = mountCanvas();
      pumpFrame();
      const before = contexts.length;
      await wrapper.setProps({ upcomingPattern: upcoming });
      await nextTick();
      pumpFrame();
      pumpFrame();

      // The pre-render surface was painted.
      const prerender = contexts.slice(before);
      expect(prerender.length).toBeGreaterThan(0);
      const prerenderFills = fillsOn(prerender[0]!).length;
      expect(prerenderFills).toBeGreaterThan(0);

      // New palette values + the :root style write the observer watches.
      Object.assign(fixtureVars, flippedPalette);
      flipTheme();
      await pumpUntil(() => fillsOn(prerender[0]!).length > prerenderFills);

      // The pre-render was repainted with the new palette, not left stale
      // (a stale bitmap would be adopted as the static grid on the next
      // pattern swap, wearing the old theme).
      expect(fillsOn(prerender[0]!).length).toBeGreaterThan(prerenderFills);
      wrapper.unmount();
    } finally {
      // afterEach restores fixtureVars
    }
  });
});

// ---------------------------------------------------------------------
// Pointer interaction
// ---------------------------------------------------------------------

describe('pointer → cell', () => {
  it('a click at a cell center emits cellSelected with the hitTest payload', async () => {
    const wrapper = mountCanvas();
    const { overlay } = layerCanvases(wrapper);
    mockCanvasRect(overlay);

    // Center of track 0 at row 2, in client coords (canvas at 0,0 and
    // viewTop/viewLeft are 0).
    const x = GUTTER_WIDTH_PX + 180 / 2;
    const y = 2 * rowPitchPx + rowHeightPx / 2;
    dispatchMouse(overlay, 'mousedown', x, y);
    dispatchMouse(window, 'mouseup', x, y);
    await nextTick();

    const hit = hitTest(
      x - GUTTER_WIDTH_PX,
      y,
      { trackCount: 2, showExtraEffectColumn: false, rowCount: 32 },
      0,
    );
    expect(hit).not.toBeNull();
    const expectedPayload: Record<string, unknown> = {
      row: hit!.row,
      column: hit!.column,
      trackIndex: hit!.trackIndex,
    };
    if (hit!.macroNibble !== undefined) {
      expectedPayload.macroNibble = hit!.macroNibble;
    }
    expect(wrapper.emitted('cellSelected')).toEqual([[expectedPayload]]);
    // The same down/up also opened (and closed) a selection.
    expect(wrapper.emitted('startSelection')).toEqual([[{ row: 2, trackIndex: 0 }]]);
    wrapper.unmount();
  });
});

describe('selection drag', () => {
  it('mousedown starts a selection; window mousemove hovers it', async () => {
    const wrapper = mountCanvas();
    const { overlay } = layerCanvases(wrapper);
    mockCanvasRect(overlay);

    const startX = GUTTER_WIDTH_PX + 180 / 2;
    const startY = 1 * rowPitchPx + rowHeightPx / 2;
    dispatchMouse(overlay, 'mousedown', startX, startY);
    await nextTick();
    expect(wrapper.emitted('startSelection')).toEqual([[{ row: 1, trackIndex: 0 }]]);

    // Drag two rows down inside the same track; the component listens on
    // window, so the moves never touch the canvas itself.
    dispatchMouse(window, 'mousemove', startX, startY + 2 * rowPitchPx);
    await nextTick();
    expect(wrapper.emitted('hoverSelection')).toEqual([[{ row: 3, trackIndex: 0 }]]);
    wrapper.unmount();
  });

  it('mousemove without a mousedown emits nothing', () => {
    const wrapper = mountCanvas();
    dispatchMouse(window, 'mousemove', 100, 100);
    expect(wrapper.emitted('hoverSelection')).toBeUndefined();
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Mode accents
// ---------------------------------------------------------------------

describe('playback bar accents', () => {
  it('paints the pattern-mode pills with #4df2c5 at playbackRow', async () => {
    const wrapper = mountCanvas({ playbackRow: 2, playbackMode: 'pattern' });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    // Two rounded pills at the playback row (tracks + row-number gutter),
    // translated into viewport space (− scrollTop).
    const pills = overlayCtx.calls.filter(
      (call): call is PathCall =>
        call.op === 'path' &&
        Math.abs(call.y - (2 * rowPitchPx - 0)) < 0.5 &&
        call.height === rowHeightPx,
    );
    expect(pills).toHaveLength(2);
    expect(pills.every((p) => p.radius === 10)).toBe(true);
    expect(overlayCtx.props.get('strokeStyle')).toBe('#4df2c5');
    expect(overlayCtx.props.get('fillStyle')).toBe('rgba(77, 242, 197, 0.12)');
    wrapper.unmount();
  });

  it('paints the song-mode pills with rgb(88, 176, 255) at playbackRow', async () => {
    const wrapper = mountCanvas({ playbackRow: 2, playbackMode: 'song' });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const pills = overlayCtx.calls.filter(
      (call): call is PathCall =>
        call.op === 'path' &&
        Math.abs(call.y - 2 * rowPitchPx) < 0.5 &&
        call.height === rowHeightPx,
    );
    expect(pills).toHaveLength(2);
    expect(overlayCtx.props.get('strokeStyle')).toBe('rgb(88, 176, 255)');
    expect(overlayCtx.props.get('fillStyle')).toBe('rgba(88, 176, 255, 0.14)');
    wrapper.unmount();
  });

  it('keeps the gutter pill on the row-number labels under horizontal scroll', async () => {
    // Regression for the 2026-09-04 phone report (round 2): the old pin
    // glued the gutter pill to the viewport's left edge while the static
    // bitmap's row-number labels panned away with the content, so the pill
    // clung over scrolled-away track content and slid under the tracks
    // pill. The pill must share the labels' screen x at every pan
    // position: the blit pans the bitmap by −viewLeft (drawImage sx =
    // viewLeft·scale), and the overlay layer translates by (gutter −
    // viewLeft), so the pill drawn at pattern x −78 must land at screen x
    // −viewLeft — exactly the labels' rect.
    const scrollLeft = 30;
    const wrapper = mountCanvas({ playbackRow: 2, scrollLeft, playbackMode: 'pattern' });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const pills = overlayCtx.calls.filter(
      (call): call is PathCall =>
        call.op === 'path' &&
        Math.abs(call.y - 2 * rowPitchPx) < 0.5 &&
        call.height === rowHeightPx,
    );
    expect(pills).toHaveLength(2);
    // Gutter pill: drawn at pattern x −78, layer translate 78 − 30 →
    // screen x −30 — where the blit just put the bitmap's x-[0,78) labels.
    const gutterPill = pills.find((p) => p.width === GUTTER_WIDTH_PX);
    expect(gutterPill!.x).toBe(-scrollLeft);
    // Tracks pill stays at pattern-space 0 → screen 78 − 30. Edge-adjacent
    // to the gutter pill (78 − 30 = −30 + 78), never overlapping it.
    const tracksPill = pills.find((p) => p.width === activeRowBarWidthPx(2, false));
    expect(tracksPill!.x).toBe(GUTTER_WIDTH_PX - scrollLeft);
    expect(gutterPill!.x + GUTTER_WIDTH_PX).toBe(tracksPill!.x);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Sizing: pure viewport resizes reuse the bitmap; huge patterns fail over
// ---------------------------------------------------------------------

describe('resize scheduling', () => {
  it('a pure viewport resize repaints the layers without rebuilding the bitmap', async () => {
    const wrapper = mountCanvas();
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const staticFillsBefore = fillsOn(bitmap).length;
    expect(staticFillsBefore).toBeGreaterThan(0);

    // The ResizeObserver path: a new viewport size, same pattern, same DPR.
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get: () => VIEWPORT_W + 60,
    });
    try {
      fireComponentResize();
      // Frame 1 runs applySize (scheduling overlay+blit); frame 2 executes
      // it — without the second pump a wrongly-scheduled static repaint
      // would never execute and this test would pass vacuously.
      await nextTick();
      pumpFrame();
      pumpFrame();

      // The bitmap was not cleared/repainted; the visible layer was blitted
      // again from the still-valid bitmap.
      expect(fillsOn(bitmap).length).toBe(staticFillsBefore);
      const { visible } = layerCanvases(wrapper);
      const viewCtx = contexts.find((c) => c.canvas === visible)!;
      expect(drawImageOn(viewCtx).length).toBeGreaterThan(0);
    } finally {
      restoreViewport();
    }
    wrapper.unmount();
  });

  it('a DPR or pattern-extent change rebuilds the static bitmap', async () => {
    const wrapper = mountCanvas();
    pumpFrame();
    const bitmapBefore = bitmapOf(wrapper);
    expect(fillsOn(bitmapBefore).length).toBeGreaterThan(0);

    // Stub the property on window itself: the component reads
    // window.devicePixelRatio at applySize time, and vi.stubGlobal's
    // globalThis patch does not reliably reach the jsdom window object.
    const dprDescriptor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio') ?? {
      configurable: true,
      value: 1,
    };
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2,
    });
    try {
      fireComponentResize();
      // Frame 1 runs applySize (which schedules the repaint); frame 2 runs it.
      await nextTick();
      pumpFrame();
      pumpFrame();

      // New backing-store size ⇒ a different bitmap canvas was painted.
      const bitmapAfter = bitmapOf(wrapper);
      expect(bitmapAfter.canvas).not.toBe(bitmapBefore.canvas);
      expect(fillsOn(bitmapAfter).length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', dprDescriptor);
    }
    wrapper.unmount();
  });
});

describe('bitmap size cap', () => {
  it('a pattern whose bitmap exceeds the device-px ceiling emits rendererError once', async () => {
    // 512 tracks × 4096 rows blows far past the 64M device-px cap even at
    // DPR 1; a real browser would silently fail to allocate this canvas.
    const manyTracks = Array.from({ length: 512 }, (_, i) => makeTrack(`t${i}`, 4));
    const wrapper = mountCanvas({ tracks: manyTracks, rows: 4096 });
    await pumpFrame();

    const errors = wrapper.emitted('rendererError');
    expect(errors).toHaveLength(1);
    const error = (errors![0] as unknown[])[0] as Error;
    expect(error.message).toMatch(/device-pixel cap/i);

    // One-shot: later scrolls must not re-emit.
    await wrapper.setProps({ scrollTop: 10 });
    await pumpFrame();
    expect(wrapper.emitted('rendererError')).toHaveLength(1);
    wrapper.unmount();
  });

  it('a normal pattern stays under the cap and never emits rendererError', async () => {
    const wrapper = mountCanvas();
    await pumpFrame();
    expect(wrapper.emitted('rendererError')).toBeUndefined();
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Cell-level edit repaint (§3.3): clip + repair, not a full repaint
// ---------------------------------------------------------------------

/** The number of fillRect ops one full static paint issues. */
function fullPaintFillCount(tracks: TrackerTrackData[], rows: number): number {
  // paintStatic: one panel fill + one row-number pill per row + one cell
  // fill per track × row.
  return 1 + rows + tracks.length * rows;
}

/** The recording ctx of one specific canvas element. */
function ctxForCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): RecordingCtx {
  const entry = contexts.find((c) => c.canvas === canvas);
  expect(entry).toBeDefined();
  return entry!;
}

/** The static bitmap canvas mounted with the component (first offscreen). */
function staticBitmapCanvasOf(wrapper: MountedCanvas): HTMLCanvasElement | OffscreenCanvas {
  const { visible, overlay } = layerCanvases(wrapper);
  const entry = contexts.find((c) => c.canvas !== visible && c.canvas !== overlay);
  expect(entry).toBeDefined();
  return entry!.canvas!;
}

/** The canvas the visible layer's latest blit read from (= current bitmap). */
function blittedBitmap(wrapper: MountedCanvas): unknown {
  const { visible } = layerCanvases(wrapper);
  const viewCtx = contexts.find((c) => c.canvas === visible)!;
  const blit = drawImageOn(viewCtx).at(-1);
  expect(blit).toBeDefined();
  return blit!.image;
}

describe('cell-level edit repaint (§3.3)', () => {
  it('a single entry edit repaints exactly one clipped cell, not the bitmap', async () => {
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;
    expect(fillsBefore).toBe(fullPaintFillCount([track, other], 32));

    await wrapper.setProps({ tracks: [editedTrack(track, 5), other] });
    await nextTick();
    pumpFrame();

    // Only the one repaired cell's ops were added to the bitmap context:
    // one fillRect for the cell background (clip bounds the rest).
    expect(fillsOn(bitmap).length).toBe(fillsBefore + 1);
    wrapper.unmount();
  });
  it('the repaired cell is clipped to its entry box at the track column', async () => {
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;

    await wrapper.setProps({ tracks: [editedTrack(track, 7), other] });
    await nextTick();
    pumpFrame();

    const repairFills = fillsOn(bitmap).slice(fillsBefore);
    expect(repairFills).toHaveLength(1);
    // entryBoxRect(0, 7): pattern space + the 78px gutter, no scroll.
    expect(repairFills[0]!.x).toBeCloseTo(GUTTER_WIDTH_PX, 5);
    expect(repairFills[0]!.y).toBeCloseTo(7 * rowPitchPx, 5);
    expect(repairFills[0]!.width).toBeCloseTo(180, 5); // 2-track trackWidth
    expect(repairFills[0]!.height).toBeCloseTo(rowHeightPx, 5);
    wrapper.unmount();
  });

  it('an empty-cell edit (step cleared) repairs that one cell too', async () => {
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;

    const cleared = {
      ...track,
      entries: track.entries.filter((e) => e.row !== 3),
    };
    await wrapper.setProps({ tracks: [cleared, other] });
    await nextTick();
    pumpFrame();

    expect(fillsOn(bitmap).length).toBe(fillsBefore + 1);
    wrapper.unmount();
  });

  it('edits on more than the ratio budget fall back to a full repaint', async () => {
    // 32 rows × 2 tracks = 64 cells; 17 changed > 25% → full repaint.
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;

    let edited = track;
    for (let row = 0; row < 17; row++) {
      edited = editedTrack(edited, row);
    }
    await wrapper.setProps({ tracks: [edited, other] });
    await nextTick();
    pumpFrame();

    expect(fillsOn(bitmap).length).toBe(fillsBefore * 2); // full repaint
    wrapper.unmount();
  });

  it('edits at or under the ratio stay incremental', async () => {
    // 32 rows × 2 tracks = 64 cells; 16 changed = exactly 25%.
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;

    let edited = track;
    for (let row = 0; row < 16; row++) {
      edited = editedTrack(edited, row);
    }
    await wrapper.setProps({ tracks: [edited, other] });
    await nextTick();
    pumpFrame();

    // One fillRect per repaired cell, no full second paint.
    expect(fillsOn(bitmap).length).toBe(fillsBefore + 16);
    wrapper.unmount();
  });

  it('a selection change still repaints the whole bitmap (gutter tints)', async () => {
    const track = makeTrack('t0');
    const other = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [track, other] });
    pumpFrame();
    const bitmap = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmap).length;

    await wrapper.setProps({
      selectionRect: { rowStart: 0, rowEnd: 1, trackStart: 0, trackEnd: 1 },
    });
    await nextTick();
    pumpFrame();

    // A second full paint, plus the two selected-row overlay bars that are
    // now part of it.
    expect(fillsOn(bitmap).length).toBe(fillsBefore * 2 + 2);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Upcoming-pattern pre-render (§3.2): off-path paint + ping-pong swap
// ---------------------------------------------------------------------

describe('upcoming-pattern pre-render (§3.2)', () => {
  it('while playing, the upcoming pattern is painted into a second bitmap', async () => {
    const upcoming = { id: 'p2', tracks: [makeTrack('u'), makeTrack('v')], rows: 32 };
    const wrapper = mountCanvas();
    pumpFrame();
    const before = contexts.length;

    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();
    // The off-path paint queued its own frame (no rAF-based idle callback
    // in the test env): pump it, then the frame it scheduled after.
    pumpFrame();
    pumpFrame();

    // A second bitmap surface was created and painted (fills recorded).
    const surfaces = contexts.slice(before);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(fillsOn(surfaces[0]!).length).toBeGreaterThan(0);
    wrapper.unmount();
  });

  it('a pattern swap adopts the pre-render: pointer swap, no full repaint', async () => {
    const trackA = makeTrack('t0');
    const trackB = makeTrack('t1');
    const upcoming = { id: 'p2', tracks: [makeTrack('u'), makeTrack('v')], rows: 32 };
    const wrapper = mountCanvas({ tracks: [trackA, trackB] });
    pumpFrame();
    const originalBitmap = staticBitmapCanvasOf(wrapper);
    expect(blittedBitmap(wrapper)).toBe(originalBitmap);

    // Pre-render the upcoming pattern, then swap to it.
    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();
    pumpFrame();
    pumpFrame();
    const preRendered = bitmapOf(wrapper).canvas!; // newest offscreen surface
    expect(preRendered).not.toBe(originalBitmap);
    const preRenderFills = fillsOn(bitmapOf(wrapper)).length;
    expect(preRenderFills).toBeGreaterThan(0);

    await wrapper.setProps({ tracks: upcoming.tracks, rows: upcoming.rows });
    await nextTick();
    pumpFrame();

    // The visible layer now blits from the pre-render bitmap (pointer swap,
    // §3.2), which was not repainted by the swap.
    expect(blittedBitmap(wrapper)).toBe(preRendered);
    expect(fillsOn(bitmapOf(wrapper)).length).toBe(preRenderFills);
    wrapper.unmount();
  });

  it('a swap without a usable pre-render repaints the static bitmap', async () => {
    const trackA = makeTrack('t0');
    const trackB = makeTrack('t1');
    const wrapper = mountCanvas({ tracks: [trackA, trackB] });
    pumpFrame();
    const originalCanvas = staticBitmapCanvasOf(wrapper);
    const originalCtx = ctxForCanvas(originalCanvas);
    const fillsBefore = fillsOn(originalCtx).length;

    // Swap with no upcomingPattern pre-render at all (e.g. the pattern was
    // never pre-rendered — deleted mid-play, or the paint lost the race).
    const fresh = [makeTrack('x'), makeTrack('y')];
    await wrapper.setProps({ tracks: fresh, rows: 32 });
    await nextTick();
    pumpFrame();

    // Same bitmap surface, repainted from scratch in place.
    expect(blittedBitmap(wrapper)).toBe(originalCanvas);
    expect(fillsOn(originalCtx).length).toBe(fillsBefore * 2);
    wrapper.unmount();
  });

  it('a stale pre-render (edited after painting) is not adopted', async () => {
    const trackA = makeTrack('t0');
    const trackB = makeTrack('t1');
    const upcomingTracks = [makeTrack('u'), makeTrack('v')];
    const upcoming = { id: 'p2', tracks: upcomingTracks, rows: 32 };
    const wrapper = mountCanvas({ tracks: [trackA, trackB] });
    pumpFrame();
    const bitmapBefore = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmapBefore).length;

    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();
    pumpFrame();
    pumpFrame();

    // An edit lands on the upcoming pattern AFTER the pre-render painted
    // it: the references no longer match, so the swap must repaint.
    await wrapper.setProps({
      upcomingPattern: {
        ...upcoming,
        tracks: [editedTrack(upcomingTracks[0]!, 2), upcomingTracks[1]!],
      },
    });
    await nextTick();
    pumpFrame();
    pumpFrame();
    await wrapper.setProps({ tracks: upcomingTracks, rows: 32 });
    await nextTick();
    pumpFrame();

    // The original bitmap repainted from scratch in place (no swap), and
    // the visible layer still blits from it.
    const originalCtx = ctxForCanvas(staticBitmapCanvasOf(wrapper));
    expect(blittedBitmap(wrapper)).toBe(staticBitmapCanvasOf(wrapper));
    expect(fillsOn(originalCtx).length).toBe(fillsBefore * 2);
    wrapper.unmount();
  });

  it('clearing the upcoming pattern cancels and the swap repaints fully', async () => {
    const trackA = makeTrack('t0');
    const trackB = makeTrack('t1');
    const upcoming = { id: 'p2', tracks: [makeTrack('u'), makeTrack('v')], rows: 32 };
    const wrapper = mountCanvas({ tracks: [trackA, trackB] });
    pumpFrame();
    const bitmapBefore = bitmapOf(wrapper);
    const fillsBefore = fillsOn(bitmapBefore).length;

    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();
    pumpFrame();
    await wrapper.setProps({ upcomingPattern: null });
    await nextTick();
    pumpFrame();
    pumpFrame();
    await wrapper.setProps({ tracks: [makeTrack('x'), makeTrack('y')], rows: 32 });
    await nextTick();
    pumpFrame();

    // The original bitmap repainted from scratch in place (the cleared
    // pre-render was not adopted), and the blit still reads it.
    const originalCtx = ctxForCanvas(staticBitmapCanvasOf(wrapper));
    expect(blittedBitmap(wrapper)).toBe(staticBitmapCanvasOf(wrapper));
    expect(fillsOn(originalCtx).length).toBe(fillsBefore * 2);
    wrapper.unmount();
  });

  it('the swap still blits (no blank frame) and repaints the overlay', async () => {
    const trackA = makeTrack('t0');
    const trackB = makeTrack('t1');
    const upcoming = { id: 'p2', tracks: [makeTrack('u'), makeTrack('v')], rows: 32 };
    const wrapper = mountCanvas({ tracks: [trackA, trackB] });
    pumpFrame();
    const { visible } = layerCanvases(wrapper);
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const blitsBefore = drawImageOn(viewCtx).length;

    await wrapper.setProps({ upcomingPattern: upcoming });
    await nextTick();
    pumpFrame();
    pumpFrame();
    await wrapper.setProps({ tracks: upcoming.tracks, rows: upcoming.rows });
    await nextTick();
    pumpFrame();

    expect(drawImageOn(viewCtx).length).toBe(blitsBefore + 1);
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------
// Touch-pan robustness: band repaint + single-frame view state
//
// The mobile flicker/drift report: the overlay used to be FULL-cleared
// and fully redrawn every pan frame, and the indicator could be painted
// against a different scroll state than the grid blit. These tests pin
// the band-repaint contract: pan frames clear only row bands, every
// cleared band covers the bar band the previous frame painted (no
// trails), and the blit + pills of one frame agree on the view origin.
// ---------------------------------------------------------------------

/** Band coverage with the pill-stroke pad: does `band` overlap the row? */
function bandOverlapsRow(
  band: { y: number; height: number },
  screenRowY: number,
): boolean {
  return (
    band.y < screenRowY + rowHeightPx + BAND_PAD_PX &&
    band.y + band.height > screenRowY - BAND_PAD_PX
  );
}

/** The two playback pills of the newest paint, newest first. */
function newestPills(ctx: RecordingCtx, from: number): PathCall[] {
  return pathsOn(ctx)
    .slice()
    .reverse()
    .filter((p) => p.height === rowHeightPx)
    .filter((p) => ctx.calls.indexOf(p) >= from);
}

describe('touch-pan band repaint (pan-jitter)', () => {
  it('rapid alternating pans clear only row bands, never the whole overlay', async () => {
    const wrapper = mountCanvas({ playbackRow: 2, scrollLeft: 0 });
    pumpFrame(); // mount frame: the one legitimate full paint
    const { visible, overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const viewCtx = contexts.find((c) => c.canvas === visible)!;
    const opsBeforeJitter = overlayCtx.calls.length;

    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const hscroll = wrapper.find('.canvas-hscroll').element as HTMLElement;
    const jitter = [
      { top: 100, left: 40 },
      { top: 60, left: 70 },
      { top: 140, left: 10 },
      { top: 90, left: 55 },
      { top: 30, left: 80 },
      { top: 110, left: 25 },
    ];
    let prevBarY = 2 * rowPitchPx - 0; // mount frame: view (0, 0)
    for (const view of jitter) {
      Object.defineProperty(scroller, 'scrollTop', {
        value: view.top,
        configurable: true,
      });
      Object.defineProperty(hscroll, 'scrollLeft', {
        value: view.left,
        configurable: true,
      });
      scroller.dispatchEvent(new Event('scroll'));
      hscroll.dispatchEvent(new Event('scroll'));
      await nextTick();
      const frameStart = overlayCtx.calls.length;
      pumpFrame();
      const frameOps = overlayCtx.calls.slice(frameStart);
      const clears = frameOps.filter(
        (call): call is RectCall => call.op === 'clearRect',
      );

      // Band repaint: no full-layer clear after the mount frame.
      expect(clears.length).toBeGreaterThan(0);
      for (const clear of clears) {
        expect(clear.height).toBeLessThanOrEqual(rowHeightPx + 2 * BAND_PAD_PX + 0.5);
      }
      // No trail: when the bar was on screen last frame, some cleared
      // band overlaps where it WAS. (A bar band entirely off-viewport
      // leaves nothing to clear and asserts nothing.)
      const barWasVisible =
        prevBarY + rowHeightPx + BAND_PAD_PX > 0 && prevBarY - BAND_PAD_PX < VIEWPORT_H;
      if (barWasVisible) {
        expect(clears.some((clear) => bandOverlapsRow(clear, prevBarY))).toBe(true);
      }

      // Single-frame composition: the blit and the pills of this frame
      // speak the same view state.
      const blit = drawImageOn(viewCtx).at(-1)!;
      expect(blit.sy).toBeCloseTo(view.top, 5);
      const pills = newestPills(overlayCtx, frameStart);
      expect(pills).toHaveLength(2);
      const barY = 2 * rowPitchPx - view.top;
      for (const pill of pills) expect(pill.y).toBeCloseTo(barY, 5);
      const gutterPill = pills.find((p) => p.width === GUTTER_WIDTH_PX)!;
      // The pill rides the row-number labels: the blit pans the bitmap by
      // −view.left and the pill shares that origin, so it is NEVER glued to
      // the viewport edge (the 2026-09-04 drift report).
      expect(gutterPill.x + view.left).toBe(0);
      const tracksPill = pills.find(
        (p) => p.width === activeRowBarWidthPx(2, false),
      )!;
      expect(tracksPill.x).toBeCloseTo(GUTTER_WIDTH_PX - view.left, 5);
      // Edge-adjacent to the tracks pill — never sliding under it.
      expect(gutterPill.x + GUTTER_WIDTH_PX).toBeCloseTo(tracksPill.x, 5);

      prevBarY = barY;
    }
    // Sanity: the jitter actually exercised multiple frames.
    expect(overlayCtx.calls.length).toBeGreaterThan(opsBeforeJitter);
    wrapper.unmount();
  });

  it('a stopped bar (playbackRow out of range) still clears its old band', async () => {
    const wrapper = mountCanvas({ playbackRow: 4 });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;

    // The component's setProps typing is the known TS2353 baseline class
    // every setProps({...}) call in this file trips; the cast keeps this
    // new call out of the tsc count without changing what is asserted.
    await wrapper.setProps({ playbackRow: -1 } as never);
    await nextTick();
    const frameStart = overlayCtx.calls.length;
    pumpFrame();

    const clears = overlayCtx.calls
      .slice(frameStart)
      .filter((call): call is RectCall => call.op === 'clearRect');
    expect(clears.length).toBeGreaterThan(0);
    expect(clears.some((clear) => bandOverlapsRow(clear, 4 * rowPitchPx))).toBe(true);
    // And nothing was redrawn: no new pill ops.
    expect(newestPills(overlayCtx, frameStart)).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('gutter pill tracks the gutter under programmatic pan', () => {
  it('stays on the row-number labels in every pan direction, including beyond-origin values', async () => {
    const wrapper = mountCanvas({ playbackRow: 3, scrollLeft: 0 });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const scroller = wrapper.find('.canvas-scroller').element as HTMLElement;
    const hscroll = wrapper.find('.canvas-hscroll').element as HTMLElement;

    // Right/down, left/up, and past both origin and extent — the pill must
    // stay on the gutter labels everywhere, never drifting toward the
    // screen edge or under the tracks pill. (No identity state first: an
    // unchanged scroll early-returns and runs no frame.)
    const views = [
      { top: 180, left: 45 },
      { top: 360, left: 120 },
      { top: -40, left: -60 }, // beyond origin
      { top: 99999, left: 9999 }, // far beyond the scroll extent
      { top: 90, left: 30 },
    ];
    for (const view of views) {
      Object.defineProperty(scroller, 'scrollTop', {
        value: view.top,
        configurable: true,
      });
      Object.defineProperty(hscroll, 'scrollLeft', {
        value: view.left,
        configurable: true,
      });
      scroller.dispatchEvent(new Event('scroll'));
      hscroll.dispatchEvent(new Event('scroll'));
      await nextTick();
      const frameStart = overlayCtx.calls.length;
      pumpFrame();

      const pills = newestPills(overlayCtx, frameStart);
      expect(pills).toHaveLength(2);
      const gutterPill = pills.find((p) => p.width === GUTTER_WIDTH_PX)!;
      // On the labels' screen rect — x −view.left — at every origin,
      // including out-of-range scroll values (over-scroll shifts the blit's
      // destination and the pill by the same dx). The old viewport-edge pin
      // (screen x 0) is the bug this asserts against.
      expect(gutterPill.x + view.left).toBe(0);
      expect(gutterPill.y).toBeCloseTo(3 * rowPitchPx - view.top, 5);
      const tracksPill = pills.find(
        (p) => p.width === activeRowBarWidthPx(2, false),
      )!;
      expect(tracksPill.x).toBeCloseTo(GUTTER_WIDTH_PX - view.left, 5);
      // Edge-adjacent, never overlapping, at any origin.
      expect(gutterPill.x + GUTTER_WIDTH_PX).toBeCloseTo(tracksPill.x, 5);
    }
    wrapper.unmount();
  });
});

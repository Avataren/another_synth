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
import { hitTest } from 'src/components/tracker/pattern-canvas/pattern-hit-test';
import { blitWindow } from 'src/components/tracker/pattern-canvas/pattern-window';
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
type CtxCall = RectCall | DrawImageCall;

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
    scale() {},
    rotate() {},
    beginPath() {},
    clip() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
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
      if (key in target) return (target as Record<string, unknown>)[key];
      return props.get(key);
    },
    set(target, key: string, value) {
      if (key in target) {
        (target as Record<string, unknown>)[key] = value;
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

function makeTrack(id: string, rowCount = 32, note = 'C-4'): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: rowCount }, (_, i) => ({ row: i, note })),
  };
}

function mountCanvas(opts: {
  tracks?: TrackerTrackData[];
  rows?: number;
  scrollTop?: number;
  scrollLeft?: number;
  playbackRow?: number;
  playbackMode?: 'pattern' | 'song';
} = {}) {
  return mount(PatternCanvas, {
    props: {
      tracks: opts.tracks ?? [makeTrack('t0'), makeTrack('t1')],
      rows: opts.rows ?? 32,
      selectedRow: 0,
      playbackRow: opts.playbackRow ?? 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: false,
      isPlaying: false,
      playbackMode: opts.playbackMode ?? 'pattern',
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: opts.scrollTop ?? 0,
      scrollLeft: opts.scrollLeft ?? 0,
      containerWidth: VIEWPORT_W,
      containerHeight: VIEWPORT_H,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: false,
    },
  });
}

type MountedCanvas = ReturnType<typeof mountCanvas>;

let contexts: RecordingCtx[] = [];

beforeEach(() => {
  vi.unstubAllGlobals();
  rafQueue.clear();
  resizeCallbacks.length = 0;
  installFakeRaf();
  installFakeResizeObserver();
  installViewport();
  setCache(theme); // skip getComputedStyle entirely
  contexts = stubCanvasContexts();
});

afterEach(() => {
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
    (call): call is Extract<CtxCall, { op: 'fillRect' }> => call.op === 'fillRect',
  );

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
    const overlayFillsBefore = fillsOn(overlayCtx).length;

    await wrapper.setProps({ playbackRow: 4 });
    await nextTick();
    pumpFrame();

    expect(fillsOn(bitmap).length).toBe(staticFillsBefore);
    // The playback bar repaint = clear + fill + 2px stroke.
    expect(fillsOn(overlayCtx).length).toBeGreaterThan(overlayFillsBefore);
    wrapper.unmount();
  });

  it('translates the overlay by gutter − scrollLeft and −scrollTop', async () => {
    const scrollTop = 72;
    const scrollLeft = 30;
    const wrapper = mountCanvas({ scrollTop, scrollLeft, playbackRow: 2 });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;

    const bar = fillsOn(overlayCtx)
      .filter((c) => c.height === rowHeightPx)
      .at(-1);
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
    // its pattern-space y and drift off the visible rows.
    const bar = fillsOn(overlayCtx)
      .filter((c) => c.height === rowHeightPx)
      .at(-1);
    expect(bar).toBeDefined();
    expect(bar!.y).toBeCloseTo(2 * rowPitchPx - 180, 5);
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
  it('pattern mode strokes the bar with #4df2c5', async () => {
    const wrapper = mountCanvas({ playbackRow: 2, playbackMode: 'pattern' });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const stroke = overlayCtx.calls.find(
      (call) =>
        call.op === 'strokeRect' &&
        Math.abs(call.y - 2 * rowPitchPx) < 0.5 &&
        call.height === rowHeightPx,
    );
    expect(stroke).toBeDefined();
    expect(overlayCtx.props.get('strokeStyle')).toBe('#4df2c5');
    wrapper.unmount();
  });

  it('song mode strokes the bar with rgb(88, 176, 255)', async () => {
    const wrapper = mountCanvas({ playbackRow: 2, playbackMode: 'song' });
    pumpFrame();
    const { overlay } = layerCanvases(wrapper);
    const overlayCtx = contexts.find((c) => c.canvas === overlay)!;
    const stroke = overlayCtx.calls.find(
      (call) =>
        call.op === 'strokeRect' &&
        Math.abs(call.y - 2 * rowPitchPx) < 0.5 &&
        call.height === rowHeightPx,
    );
    expect(stroke).toBeDefined();
    expect(overlayCtx.props.get('strokeStyle')).toBe('rgb(88, 176, 255)');
    expect(overlayCtx.props.get('fillStyle')).toBe('rgba(88, 176, 255, 0.14)');
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

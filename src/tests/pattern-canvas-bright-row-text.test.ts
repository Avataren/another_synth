import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import {
  GUTTER_WIDTH_PX,
  rowHeightPx,
  rowPitchPx,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { setCache } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Canvas playing-row TEXT overlay (task: light up the playing row's text,
 * nothing behind it — "run optimized at runtime, reasonable precalc is
 * fine").
 *
 * The proof:
 *  - a bright-text variant is BAKED into an offscreen surface when playback
 *    begins (once, not per tick),
 *  - each playback tick blits ONLY the playing row's strip from it onto the
 *    indicator overlay — a single drawImage, at the playing row's y,
 *  - the static bitmap is never repainted for this (its fill count is
 *    frozen across a run of row advances),
 *  - the bright glyphs are the theme note-text token.
 *
 * jsdom cannot rasterize: a call-recording 2D context stands in, rAF is a
 * manual pump (same approach as pattern-canvas.test.ts).
 */

const NOTE_TEXT = '#f0ffe0-note-sentinel';

interface DrawImageCall {
  op: 'drawImage';
  image: unknown;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}
interface RectCall {
  op: 'fillRect' | 'clearRect' | 'strokeRect';
  x: number;
  y: number;
  width: number;
  height: number;
}
interface TextCall {
  op: 'fillText';
  text: string;
  fillStyle: string;
}
type CtxCall = DrawImageCall | RectCall | TextCall;

type RecordingCtx = CanvasRenderingContext2D & {
  calls: CtxCall[];
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
};

function makeRecordingCtx(): RecordingCtx {
  const calls: CtxCall[] = [];
  const props = new Map<string, unknown>();
  const ctx = {
    canvas: null as HTMLCanvasElement | OffscreenCanvas | null,
    calls,
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'fillRect', x, y, width, height });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'strokeRect', x, y, width, height });
    },
    clearRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'clearRect', x, y, width, height });
    },
    drawImage(
      image: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ) {
      calls.push({ op: 'drawImage', image, sx, sy, sw, sh, dx, dy, dw, dh });
    },
    fillText(text: string) {
      calls.push({ op: 'fillText', text, fillStyle: String(props.get('fillStyle') ?? '') });
    },
    measureText() {
      return { width: 10 };
    },
    save() {},
    restore() {},
    setTransform() {},
    translate() {},
    scale() {},
    beginPath() {},
    closePath() {},
    clip() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    arcTo() {},
    rect() {},
    roundRect() {},
    createLinearGradient() {
      return { addColorStop() {} } as unknown as CanvasGradient;
    },
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
let contexts: RecordingCtx[] = [];
const rafQueue = new Map<number, (t: number) => void>();
let nextRafId = 1;
const VIEWPORT_W = 500;
const VIEWPORT_H = 400;
const realClientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth');
const realClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight');
const realGetComputedStyle = window.getComputedStyle.bind(window);

function pumpFrame(): void {
  const pending = [...rafQueue.values()];
  rafQueue.clear();
  for (const cb of pending) cb(performance.now());
}

beforeEach(() => {
  contexts = [];
  rafQueue.clear();
  nextRafId = 1;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: (t: number) => void) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => rafQueue.delete(id)));
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() })),
  );
  Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get: () => VIEWPORT_W });
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => VIEWPORT_H });

  const byCanvas = new WeakMap<object, RecordingCtx>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let ctx = byCanvas.get(this);
    if (!ctx) {
      ctx = makeRecordingCtx();
      ctx.canvas = this;
      byCanvas.set(this, ctx);
      contexts.push(ctx);
    }
    return ctx as unknown as CanvasRenderingContext2D;
  });

  window.getComputedStyle = ((el: Element, pseudo?: string | null) => {
    const style = realGetComputedStyle(el, pseudo ?? undefined);
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'getPropertyValue') {
          return (name: string) =>
            name === '--tracker-note-text' ? NOTE_TEXT : target.getPropertyValue(name);
        }
        return Reflect.get(target, prop);
      },
    }) as CSSStyleDeclaration;
  }) as typeof window.getComputedStyle;
  setCache(null);
});

afterEach(() => {
  window.getComputedStyle = realGetComputedStyle;
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  if (realClientWidth) Object.defineProperty(Element.prototype, 'clientWidth', realClientWidth);
  if (realClientHeight) Object.defineProperty(Element.prototype, 'clientHeight', realClientHeight);
  vi.unstubAllGlobals();
  setCache(null);
});

function makeTrack(id: string, rows = 32): TrackerTrackData {
  return { id, name: id, entries: Array.from({ length: rows }, (_, i) => ({ row: i, note: 'C-4' })) };
}

function mountCanvas(opts: { isPlaying?: boolean; playbackRow?: number } = {}) {
  return mount(PatternCanvas, {
    props: {
      tracks: [makeTrack('t0'), makeTrack('t1')],
      rows: 32,
      selectedRow: 0,
      playbackRow: opts.playbackRow ?? 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: false,
      isPlaying: opts.isPlaying ?? false,
      playbackMode: 'pattern' as const,
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: 0,
      scrollLeft: 0,
      containerWidth: VIEWPORT_W,
      containerHeight: VIEWPORT_H,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: false,
    },
  });
}

function layers(wrapper: ReturnType<typeof mountCanvas>) {
  const els = wrapper.findAll('canvas.canvas-layer');
  return { visible: els[0]!.element, overlay: els[1]!.element };
}
const ctxOf = (canvas: object) => contexts.find((c) => c.canvas === canvas)!;
const drawImagesOn = (ctx: RecordingCtx) =>
  ctx.calls.filter((c): c is DrawImageCall => c.op === 'drawImage');
const fillsOn = (ctx: RecordingCtx) => ctx.calls.filter((c) => c.op === 'fillRect');
/** The offscreen surfaces (everything that is not one of the two DOM layers). */
function offscreen(wrapper: ReturnType<typeof mountCanvas>): RecordingCtx[] {
  const { visible, overlay } = layers(wrapper);
  return contexts.filter((c) => c.canvas !== visible && c.canvas !== overlay);
}

describe('canvas playing-row text overlay', () => {
  it('does not blit any text strip while stopped', () => {
    const wrapper = mountCanvas({ isPlaying: false, playbackRow: 5 });
    pumpFrame();
    const overlayCtx = ctxOf(layers(wrapper).overlay);
    expect(drawImagesOn(overlayCtx)).toHaveLength(0);
    wrapper.unmount();
  });

  it('bakes a bright-text surface once and blits the playing row strip per tick', async () => {
    const wrapper = mountCanvas({ isPlaying: true, playbackRow: 4 });
    pumpFrame();

    const { visible, overlay } = layers(wrapper);
    const staticCtx = offscreen(wrapper)[0]!; // first offscreen = static bitmap
    const overlayCtx = ctxOf(overlay);

    const surfacesAfterMount = offscreen(wrapper).length;
    const staticFillsAfterMount = fillsOn(staticCtx).length;

    // The bright strip is one of the overlay's drawImages this frame, read
    // from an offscreen surface, at row 4's y.
    const strip = drawImagesOn(overlayCtx).at(-1)!;
    expect(strip.sy).toBeCloseTo(4 * rowPitchPx, 5);
    expect(strip.sh).toBeCloseTo(rowHeightPx, 5);
    expect(strip.dx).toBeCloseTo(-GUTTER_WIDTH_PX, 5);
    expect(strip.dy).toBeCloseTo(4 * rowPitchPx, 5);
    const brightSurface = strip.image;
    expect(brightSurface).not.toBe(visible);
    expect(brightSurface).not.toBe(overlay);

    // Bright glyphs were painted into that surface in the note-text token.
    const brightCtx = contexts.find((c) => c.canvas === brightSurface)!;
    const brightGlyphs = brightCtx.calls.filter((c): c is TextCall => c.op === 'fillText');
    expect(brightGlyphs.length).toBeGreaterThan(0);
    for (const g of brightGlyphs) expect(g.fillStyle).toBe(NOTE_TEXT);

    // Advance several rows: no new offscreen surface, no static repaint, and
    // the overlay keeps blitting the SAME bright surface, tracking the row.
    for (const row of [5, 6, 7]) {
      await wrapper.setProps({ playbackRow: row } as never);
      await nextTick();
      pumpFrame();
      expect(offscreen(wrapper).length).toBe(surfacesAfterMount);
      expect(fillsOn(staticCtx).length).toBe(staticFillsAfterMount);
      const s = drawImagesOn(overlayCtx).at(-1)!;
      expect(s.image).toBe(brightSurface);
      expect(s.sy).toBeCloseTo(row * rowPitchPx, 5);
      expect(s.dy).toBeCloseTo(row * rowPitchPx, 5);
    }
    wrapper.unmount();
  });

  it('stops blitting the strip when playback stops', async () => {
    const wrapper = mountCanvas({ isPlaying: true, playbackRow: 4 });
    pumpFrame();
    const overlayCtx = ctxOf(layers(wrapper).overlay);
    expect(drawImagesOn(overlayCtx).length).toBeGreaterThan(0);
    const before = drawImagesOn(overlayCtx).length;

    await wrapper.setProps({ isPlaying: false } as never);
    await nextTick();
    pumpFrame();
    // The stop frame repaints the overlay (bar gone) but adds no text strip.
    const after = drawImagesOn(overlayCtx).slice(before);
    expect(after).toHaveLength(0);
    wrapper.unmount();
  });
});

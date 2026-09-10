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
const EFFECT_BRIGHT = '#00ffaa-effect-bright-sentinel';

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

/** Make a recording context throw on its first bake draw call (F4). */
function throwOnSetTransform(ctx: RecordingCtx, message: string): void {
  (ctx as unknown as { setTransform: () => void }).setTransform = () => {
    throw new Error(message);
  };
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
          return (name: string) => {
            if (name === '--tracker-note-text') return NOTE_TEXT;
            if (name === '--tracker-effect-text-bright') return EFFECT_BRIGHT;
            return target.getPropertyValue(name);
          };
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

function mountCanvas(
  opts: { isPlaying?: boolean; playbackRow?: number; tracks?: TrackerTrackData[] } = {},
) {
  return mount(PatternCanvas, {
    props: {
      tracks: opts.tracks ?? [makeTrack('t0'), makeTrack('t1')],
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

    // Bright glyphs were painted into that surface: note columns in the
    // note-text token, effect/macro columns in their own brighter hue
    // (MINOR-4) — not one flat colour for every glyph.
    const brightCtx = contexts.find((c) => c.canvas === brightSurface)!;
    const brightGlyphs = brightCtx.calls.filter((c): c is TextCall => c.op === 'fillText');
    expect(brightGlyphs.length).toBeGreaterThan(0);
    const brightStyles = new Set(brightGlyphs.map((g) => g.fillStyle));
    expect(brightStyles.has(NOTE_TEXT)).toBe(true);
    expect(brightStyles.has(EFFECT_BRIGHT)).toBe(true);
    expect(brightStyles).toEqual(new Set([NOTE_TEXT, EFFECT_BRIGHT]));

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

const textCount = (ctx: RecordingCtx) =>
  ctx.calls.filter((c): c is TextCall => c.op === 'fillText').length;

/**
 * MAJOR-1: the bright-text surface allocation is budget-gated and wrapped —
 * a throw (iOS canvas-memory cap) must never escape runFrame and wedge the
 * rAF loop; a failed allocation just skips the effect for the frame.
 *
 * Fails on f9abc2b: there `ensureBrightRowText` does a bare
 * `new OffscreenCanvas(w, h)` with no try/catch, so the throw propagates out
 * of `pumpFrame`.
 */
describe('canvas playing-row text overlay — degraded allocation (MAJOR-1)', () => {
  it('skips the strip without throwing when the surface cannot be allocated', async () => {
    const wrapper = mountCanvas({ isPlaying: false, playbackRow: 4 });
    pumpFrame(); // static bitmap builds first, via the real createElement
    const overlayCtx = ctxOf(layers(wrapper).overlay);

    class ThrowingOffscreen {
      constructor() {
        throw new Error('OffscreenCanvas: allocation failed');
      }
    }
    vi.stubGlobal('OffscreenCanvas', ThrowingOffscreen);
    const realCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (String(tag).toLowerCase() === 'canvas') throw new Error('no canvas element');
      return realCreate(tag);
    }) as unknown as typeof document.createElement);

    try {
      await wrapper.setProps({ isPlaying: true, playbackRow: 4 } as never);
      await nextTick();
      expect(() => pumpFrame()).not.toThrow();
      expect(drawImagesOn(overlayCtx)).toHaveLength(0);

      // The rAF loop is not wedged: playback keeps advancing, every frame
      // repaints the overlay, and no bright strip is ever blitted.
      for (const row of [5, 6, 7]) {
        await wrapper.setProps({ playbackRow: row } as never);
        await nextTick();
        const before = overlayCtx.calls.length;
        expect(() => pumpFrame()).not.toThrow();
        expect(overlayCtx.calls.length).toBeGreaterThan(before);
        expect(drawImagesOn(overlayCtx)).toHaveLength(0);
      }
    } finally {
      createSpy.mockRestore();
      wrapper.unmount();
    }
  });
});

/**
 * F4: the bake's DRAW phase (setTransform/clearRect/drawBright*) is wrapped,
 * not just the allocation. A context/draw-phase throw (context loss, an
 * exhausted GPU) must degrade to plain text and never propagate out of
 * paintOverlay→runFrame (no try/catch there) or the deferred idle callback.
 *
 * Fails on 1f38684: there only `new OffscreenCanvas` is wrapped; the
 * setTransform/clearRect/drawBrightRow* calls run bare, so a draw-phase throw
 * escapes pumpFrame.
 */
describe('canvas playing-row text overlay — draw-phase throw (F4)', () => {
  it('degrades to plain text without wedging playback when the bake draw phase throws', async () => {
    const wrapper = mountCanvas({ isPlaying: false, playbackRow: 4 });
    pumpFrame(); // static bitmap + the two DOM layers get their clean contexts
    const overlayCtx = ctxOf(layers(wrapper).overlay);

    // Any canvas created from here on (i.e. the bright-text surface) gets a
    // context that throws on the first draw call of the bake; the already-built
    // static bitmap and DOM layers keep their clean cached contexts.
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      const existing = contexts.find((c) => c.canvas === this);
      if (existing) return existing as unknown as CanvasRenderingContext2D;
      const ctx = makeRecordingCtx();
      ctx.canvas = this;
      throwOnSetTransform(ctx, 'context lost during bright-text bake');
      contexts.push(ctx);
      return ctx as unknown as CanvasRenderingContext2D;
    });

    try {
      // Synchronous first bake (playback start) — reached inside runFrame.
      await wrapper.setProps({ isPlaying: true, playbackRow: 4 } as never);
      await nextTick();
      expect(() => pumpFrame()).not.toThrow();
      expect(drawImagesOn(overlayCtx)).toHaveLength(0);

      // The rAF loop is not wedged: playback keeps advancing, every frame
      // repaints the overlay, and the row just shows plain text.
      for (const row of [5, 6, 7]) {
        await wrapper.setProps({ playbackRow: row } as never);
        await nextTick();
        const before = overlayCtx.calls.length;
        expect(() => pumpFrame()).not.toThrow();
        expect(overlayCtx.calls.length).toBeGreaterThan(before);
        expect(drawImagesOn(overlayCtx)).toHaveLength(0);
      }
    } finally {
      wrapper.unmount();
    }
  });

  it('degrades without throwing when the DEFERRED re-bake draw phase throws', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const baseTracks = [makeTrack('t0'), makeTrack('t1')];
    const wrapper = mountCanvas({ isPlaying: true, playbackRow: 2, tracks: baseTracks });
    pumpFrame(); // first bake succeeds with a clean context

    const overlayCtx = ctxOf(layers(wrapper).overlay);
    const brightSurface = drawImagesOn(overlayCtx).at(-1)!.image;
    const brightCtx = contexts.find((c) => c.canvas === brightSurface)!;
    // Poison the reused bright surface's context for the next (deferred) bake.
    throwOnSetTransform(brightCtx, 'context lost during deferred re-bake');

    const edited: TrackerTrackData[] = [
      {
        ...baseTracks[0]!,
        entries: baseTracks[0]!.entries.map((e, i) => (i === 1 ? { row: 1, note: 'D-5' } : e)),
      },
      baseTracks[1]!,
    ];
    await wrapper.setProps({ tracks: edited } as never);
    await nextTick();
    await wrapper.setProps({ playbackRow: 3 } as never);
    await nextTick();

    // Critical frame: no inline re-bake, no throw.
    expect(() => pumpFrame()).not.toThrow();
    const stripsBeforeDeferred = drawImagesOn(overlayCtx).length;
    // Deferred re-bake fires on the next scheduled callback — the draw throws,
    // is swallowed, and the row falls back to plain text.
    expect(() => pumpFrame()).not.toThrow();
    // Playback keeps running, every frame repaints the overlay, and no further
    // bright strip is ever blitted.
    for (const row of [4, 5]) {
      await wrapper.setProps({ playbackRow: row } as never);
      await nextTick();
      const before = overlayCtx.calls.length;
      expect(() => pumpFrame()).not.toThrow();
      expect(overlayCtx.calls.length).toBeGreaterThan(before);
    }
    expect(drawImagesOn(overlayCtx).length).toBe(stripsBeforeDeferred);

    wrapper.unmount();
  });
});

/**
 * MAJOR-2: a cell edit during playback invalidates the bright layer, but the
 * re-bake is deferred off the critical playback frame (idle callback, rAF
 * fallback). The stale surface is never blitted while the re-bake is pending.
 *
 * Fails on f9abc2b: there the repaintCells call site invalidates
 * synchronously, so the very next playback overlay frame re-bakes the whole
 * pattern's bright text inline (glyph count jumps) and blits it.
 */
describe('canvas playing-row text overlay — deferred re-bake on edit (MAJOR-2)', () => {
  it('does not re-bake or blit on the critical frame after a cell edit', async () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    const baseTracks = [makeTrack('t0'), makeTrack('t1')];
    const wrapper = mountCanvas({ isPlaying: true, playbackRow: 2, tracks: baseTracks });
    pumpFrame();

    const overlayCtx = ctxOf(layers(wrapper).overlay);
    const brightSurface = drawImagesOn(overlayCtx).at(-1)!.image;
    const brightCtx = contexts.find((c) => c.canvas === brightSurface)!;

    const glyphsAfterFirstBake = textCount(brightCtx);
    expect(glyphsAfterFirstBake).toBeGreaterThan(0);

    // Edit one cell (new entries array, one replaced entry object) and advance
    // the playhead, so the next frame repairs the static cell AND repaints the
    // overlay — the critical playback frame.
    const edited: TrackerTrackData[] = [
      {
        ...baseTracks[0]!,
        entries: baseTracks[0]!.entries.map((e, i) => (i === 1 ? { row: 1, note: 'D-5' } : e)),
      },
      baseTracks[1]!,
    ];
    await wrapper.setProps({ tracks: edited } as never);
    await nextTick();
    await wrapper.setProps({ playbackRow: 3 } as never);
    await nextTick();

    const overlayImagesBefore = drawImagesOn(overlayCtx).length;
    pumpFrame();
    // No inline re-bake, and the stale surface is not blitted.
    expect(textCount(brightCtx)).toBe(glyphsAfterFirstBake);
    expect(drawImagesOn(overlayCtx).length).toBe(overlayImagesBefore);

    // The deferred re-bake runs on the next scheduled callback, then the
    // strip blits again.
    pumpFrame();
    expect(textCount(brightCtx)).toBeGreaterThan(glyphsAfterFirstBake);
    pumpFrame();
    const strip = drawImagesOn(overlayCtx).at(-1)!;
    expect(strip.image).toBe(brightSurface);
    expect(strip.sy).toBeCloseTo(3 * rowPitchPx, 5);

    wrapper.unmount();
  });
});

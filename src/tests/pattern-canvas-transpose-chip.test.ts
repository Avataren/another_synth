import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount } from '@vue/test-utils';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { setCache } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { PatternTheme } from 'src/components/tracker/pattern-canvas/pattern-theme';
import { buildTrackAccents } from 'src/components/tracker/pattern-canvas/track-accents';
import { trackAccent } from 'src/components/tracker/pattern-canvas/pattern-draw';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * The canvas header's transpose chip (plan-ahx-transpose-header.md): labels
 * render only for an AHX mount, click hands off to the panel, wheel steps
 * through an accumulate-then-step threshold. The header strip is DOM, so the
 * assertions are DOM-level; the canvas mocks exist only so the mount's paint
 * path has somewhere to go (same philosophy as pattern-canvas.test.ts).
 */

const originalGetContext = HTMLCanvasElement.prototype.getContext;

function stubCanvasContexts(): void {
  const byCanvas = new WeakMap<object, unknown>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    function (this: HTMLCanvasElement) {
      let ctx = byCanvas.get(this);
      if (!ctx) {
        ctx = makeNoopCtx();
        byCanvas.set(this, ctx);
      }
      return ctx as unknown as CanvasRenderingContext2D;
    },
  );
}

/** A call-eating 2D context: enough for the paint path, records nothing. */
function makeNoopCtx(): unknown {
  const base: Record<string, unknown> = {
    canvas: null,
    fillRect() {},
    strokeRect() {},
    clearRect() {},
    drawImage() {},
    fillText() {},
    strokeText() {},
    measureText() {
      return { width: 8 };
    },
    translate() {},
    scale() {},
    rotate() {},
    save() {},
    restore() {},
    setTransform() {},
    beginPath() {},
    clip() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    arc() {},
    rect() {},
    roundRect() {},
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
  };
  const props = new Map<string, unknown>();
  return new Proxy(base, {
    get(target, key: string) {
      if (key in target) return target[key];
      return props.get(key);
    },
    set(target, key: string, value) {
      if (key in target) target[key] = value;
      else props.set(key, value);
      return true;
    },
  });
}

const rafQueue = new Map<number, (time: number) => void>();
let nextRafId = 1;
const resizeCallbacks: ((entries: unknown[]) => void)[] = [];

function installStubs(): void {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: (time: number) => void) => {
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
  vi.stubGlobal(
    'ResizeObserver',
    vi.fn().mockImplementation((cb: (entries: unknown[]) => void) => {
      resizeCallbacks.push(cb);
      return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
    }),
  );
  Object.defineProperty(Element.prototype, 'clientWidth', {
    configurable: true,
    get: () => 500,
  });
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => 400,
  });
}

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
  accentComplement: 'rgb(242, 122, 77)',
  accentComplementAlt: 'rgb(255, 167, 88)',
  noteText: '#ffffff',
  instrumentText: 'rgba(255, 255, 255, 0.82)',
  volumeText: '#85b7ff',
  effectText: '#8ef5c5',
  effectTextBright: '#c8ffe4',
  defaultText: '#d8e7ff',
  rowNumberText: '#a7bcd8',
  interpolatedLinear: 'rgba(77, 242, 197, 0.08)',
  interpolatedExponential: 'rgba(158, 197, 255, 0.1)',
  panelBackground: '#0a0e16',
  fontTracker: "'JetBrains Mono', monospace",
  trackAccents: buildTrackAccents('rgb(77, 242, 197)', 'rgb(88, 176, 255)'),
};

function makeTrack(id: string): TrackerTrackData {
  return {
    id,
    name: `Track ${id}`,
    entries: Array.from({ length: 32 }, (_, row) => ({ row, note: 'C-4' })),
  };
}

function mountCanvas(opts: {
  transposeLabels?: readonly string[];
  transposeTitles?: readonly string[];
} = {}) {
  return mount(PatternCanvas, {
    props: {
      tracks: [makeTrack('t0'), makeTrack('t1'), makeTrack('t2'), makeTrack('t3')],
      rows: 32,
      selectedRow: 0,
      playbackRow: 0,
      activeTrack: -1,
      activeColumn: -1,
      autoScroll: false,
      isPlaying: false,
      playbackMode: 'pattern',
      activeMacroNibble: 0,
      selectionRect: null,
      scrollTop: 0,
      scrollLeft: 0,
      containerWidth: 500,
      containerHeight: 400,
      isMouseSelecting: false,
      showExtraEffectColumn: false,
      reserveSideGutter: false,
      ...(opts.transposeLabels === undefined ? {} : { transposeLabels: opts.transposeLabels }),
      ...(opts.transposeTitles === undefined ? {} : { transposeTitles: opts.transposeTitles }),
    },
  });
}

function chips(wrapper: ReturnType<typeof mountCanvas>) {
  return wrapper.findAll('[data-testid="track-transpose-chip"]');
}

beforeEach(() => {
  stubCanvasContexts();
  installStubs();
  setCache(theme);
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  vi.unstubAllGlobals();
  setCache(null);
  rafQueue.clear();
  resizeCallbacks.length = 0;
});

describe('PatternCanvas header transpose chip', () => {
  it('renders nothing without transposeLabels (every non-AHX mount)', () => {
    const wrapper = mountCanvas();
    expect(chips(wrapper).length).toBe(0);
  });

  it('renders one chip per channel with the shared T wording', () => {
    const wrapper = mountCanvas({
      transposeLabels: ['T0', 'T-1', 'T+3', 'T0'],
      transposeTitles: ['zero', 'shift minus one', 'shift plus three', 'zero again'],
    });
    const found = chips(wrapper);
    expect(found.length).toBe(4);
    expect(found.map((chip) => chip.text())).toEqual(['T0', 'T-1', 'T+3', 'T0']);
    // Zero is explicit (same wording module as the DOM badge), muted.
    expect(found[0]!.classes()).toContain('transpose-zero');
    expect(found[1]!.classes()).not.toContain('transpose-zero');
    // The tooltip is whatever the page computed (the shared wording module).
    expect(found[1]!.attributes('title')).toBe('shift minus one');
  });

  it('emits transposeChipClick with the channel index (the hand-off)', async () => {
    const wrapper = mountCanvas({ transposeLabels: ['T0', 'T0', 'T-3', 'T0'] });
    await chips(wrapper)[2]!.trigger('click');
    expect(wrapper.emitted('transposeChipClick')).toEqual([[2]]);
  });

  it('emits one transposeChipStep per wheel threshold with the delta sign', async () => {
    const wrapper = mountCanvas({ transposeLabels: ['T0', 'T0', 'T0', 'T0'] });
    const chip = chips(wrapper)[1]!;
    await chip.trigger('wheel', { deltaY: 120 });
    await chip.trigger('wheel', { deltaY: -150 });
    expect(wrapper.emitted('transposeChipStep')).toEqual([
      [1, 1],
      [1, -1],
    ]);
  });

  it('accumulates sub-threshold trackpad deltas before stepping', async () => {
    const wrapper = mountCanvas({ transposeLabels: ['T0', 'T0', 'T0', 'T0'] });
    const chip = chips(wrapper)[0]!;
    await chip.trigger('wheel', { deltaY: -40 });
    await chip.trigger('wheel', { deltaY: -40 });
    expect(wrapper.emitted('transposeChipStep')).toBeUndefined();
    await chip.trigger('wheel', { deltaY: -40 });
    expect(wrapper.emitted('transposeChipStep')).toEqual([[0, -1]]);
  });

  it('resets the accumulator between chips', async () => {
    const wrapper = mountCanvas({ transposeLabels: ['T0', 'T0', 'T0', 'T0'] });
    const found = chips(wrapper);
    await found[0]!.trigger('wheel', { deltaY: -60 });
    await found[1]!.trigger('wheel', { deltaY: -60 });
    expect(wrapper.emitted('transposeChipStep')).toBeUndefined();
  });

  // plan-hvl-header-ux-0923.md BUG 1: an HVL or doc-less AHX import shows the
  // byte the engine plays but takes no edit — labels render, nothing emits,
  // and the chip drops the resize cursor so it never promises an edit.
  it('renders read-only chips that emit nothing and lose the resize cursor', async () => {
    const wrapper = mount(PatternCanvas, {
      props: {
        tracks: [makeTrack('t0'), makeTrack('t1'), makeTrack('t2'), makeTrack('t3')],
        rows: 32,
        selectedRow: 0,
        playbackRow: 0,
        activeTrack: -1,
        activeColumn: -1,
        autoScroll: false,
        isPlaying: false,
        playbackMode: 'pattern',
        activeMacroNibble: 0,
        selectionRect: null,
        scrollTop: 0,
        scrollLeft: 0,
        containerWidth: 500,
        containerHeight: 400,
        isMouseSelecting: false,
        showExtraEffectColumn: false,
        reserveSideGutter: false,
        transposeLabels: ['T0', 'T-1', 'T+3', 'T0'],
        transposeTitles: ['read-only zero', 'read-only shift', 'read-only plus', 'read-only zero'],
        transposeEditable: false,
      },
    });
    const found = chips(wrapper);
    expect(found.length).toBe(4);
    expect(found.map((chip) => chip.text())).toEqual(['T0', 'T-1', 'T+3', 'T0']);
    for (const chip of found) expect(chip.classes()).toContain('transpose-readonly');
    await found[2]!.trigger('click');
    await found[0]!.trigger('wheel', { deltaY: 120 });
    await found[0]!.trigger('wheel', { deltaY: -150 });
    expect(wrapper.emitted('transposeChipClick')).toBeUndefined();
    expect(wrapper.emitted('transposeChipStep')).toBeUndefined();
  });

  it('stays interactive when transposeEditable is left at its default', async () => {
    const wrapper = mountCanvas({ transposeLabels: ['T0', 'T0', 'T0', 'T0'] });
    const found = chips(wrapper);
    for (const chip of found) expect(chip.classes()).not.toContain('transpose-readonly');
    await found[1]!.trigger('wheel', { deltaY: 120 });
    expect(wrapper.emitted('transposeChipStep')).toEqual([[1, 1]]);
  });
});

/*
 * The header strip's per-track accent beyond 8 tracks
 * (plan-hvl-header-ux-0923.md BUG 2): the chips are DOM styled through
 * `headerTrackStyle`, so a 12-track mount exercises the real renderer path
 * — the same `trackAccent` call the paint loop makes — and must show the
 * smooth continuation, not the modulo restart.
 */
describe('PatternCanvas header accents for wide songs', () => {
  it('continues the shading smoothly across 12 tracks', () => {
    const wrapper = mount(PatternCanvas, {
      props: {
        tracks: Array.from({ length: 12 }, (_, i) => makeTrack(`t${i}`)),
        rows: 32,
        selectedRow: 0,
        playbackRow: 0,
        activeTrack: -1,
        activeColumn: -1,
        autoScroll: false,
        isPlaying: false,
        playbackMode: 'pattern',
        activeMacroNibble: 0,
        selectionRect: null,
        scrollTop: 0,
        scrollLeft: 0,
        containerWidth: 500,
        containerHeight: 400,
        isMouseSelecting: false,
        showExtraEffectColumn: false,
        reserveSideGutter: false,
      },
    });
    const headers = wrapper.findAll('.header-track');
    expect(headers.length).toBe(12);
    const accents = headers.map((header) => {
      const match = /--track-accent:\s*([^;]+)/.exec(header.attributes('style') ?? '');
      expect(match, header.attributes('style')).not.toBeNull();
      return match![1]!.trim();
    });
    const expected = Array.from({ length: 12 }, (_, i) => trackAccent(i, theme));
    expect(accents).toEqual(expected);
    // Track 9 must not be the ramp restart the modulo wrap produced.
    expect(accents[8]).not.toBe(accents[0]);
  });
});

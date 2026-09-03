import { describe, it, expect } from 'vitest';
import {
  buildInterpolatedRows,
  drawActiveRowBar,
  drawEntryBox,
  drawRowNumbers,
  drawSelectionBar,
  drawStaticGrid,
  rowType,
  trackAccent,
} from 'src/components/tracker/pattern-canvas/pattern-draw';
import {
  columnFractionOffsets,
  entryHorizontalInsetPx,
  macroNibbleWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { trackWidthPx } from 'src/components/tracker/track-metrics';
import { activeRowBarWidthPx } from 'src/components/tracker/pattern-buffering';
import type { PatternTheme } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type {
  TrackerEntryData,
  TrackerSelectionRect,
  TrackerTrackData,
} from 'src/components/tracker/tracker-types';

/**
 * Draw-op parity tests: a call-recording mock CanvasRenderingContext2D
 * stands in for jsdom's canvas stub, and the assertions pin what the canvas
 * renderer paints against the DOM grid's CSS (TrackerEntry.vue striping
 * classes, TrackerPattern.vue's row-number gutter + playback bar).
 */

interface RectCall {
  op: 'fillRect' | 'strokeRect';
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

interface PathCall {
  op: 'path';
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
}

interface TextCall {
  op: 'fillText';
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  font: string;
}

type CtxCall = RectCall | PathCall | TextCall;

function makeMockCtx() {
  const calls: CtxCall[] = [];
  const props: Record<string, unknown> = {};
  const record = () => ({
    fillStyle: String(props.fillStyle ?? ''),
    strokeStyle: String(props.strokeStyle ?? ''),
    lineWidth: Number(props.lineWidth ?? 1),
  });
  const ctx = {
    calls,
    props,
    fill() {},
    stroke() {},
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'fillRect' as const, x, y, width, height, ...record() });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      calls.push({ op: 'strokeRect' as const, x, y, width, height, ...record() });
    },
    // The renderer traces pills through roundRect (before fill/stroke), so
    // the style values at trace time are recorded with the geometry.
    roundRect(
      x: number,
      y: number,
      width: number,
      height: number,
      radius: number,
    ) {
      calls.push({ op: 'path' as const, x, y, width, height, radius, ...record() });
    },
    arcTo() {
      // The rounded-pill fallback traces arcTo corners; the mocked geometry
      // is asserted via the renderer's beginPath'd roundRect call instead.
    },
    fillText(text: string, x: number, y: number) {
      calls.push({
        op: 'fillText' as const,
        text,
        x,
        y,
        fillStyle: String(props.fillStyle ?? ''),
        font: String(props.font ?? ''),
      });
    },
    clearRect() {},
    measureText() {
      return { width: 10 };
    },
    save() {},
    restore() {},
    beginPath() {},
    clip() {},
  };
  return new Proxy(ctx as unknown as CanvasRenderingContext2D, {
    get(target, key: string) {
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return props[key as string];
    },
    set(target, key: string, value) {
      if (key in target) {
        (target as unknown as Record<string, unknown>)[key] = value;
      } else {
        props[key as string] = value;
      }
      return true;
    },
  }) as CanvasRenderingContext2D & { calls: CtxCall[]; props: Record<string, unknown> };
}

type MockCtx = ReturnType<typeof makeMockCtx>;

/** Theme fixture: the literal fallback palette the DOM stylesheets hard-code. */
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
  accentPrimary: 'rgb(77, 242, 197)',
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

const layout = (trackCount = 2, showExtraEffectColumn = false, rowCount = 32) => ({
  trackCount,
  showExtraEffectColumn,
  rowCount,
});

function makeTrack(entries: TrackerEntryData[], color?: string): TrackerTrackData {
  const track: TrackerTrackData = { id: 't1', name: 'T1', entries };
  if (color !== undefined) track.color = color;
  return track;
}

const fills = (ctx: MockCtx) =>
  ctx.calls.filter((c): c is RectCall => c.op === 'fillRect');
const paths = (ctx: MockCtx) =>
  ctx.calls.filter((c): c is PathCall => c.op === 'path');
const strokes = (ctx: MockCtx) =>
  ctx.calls.filter((c): c is RectCall => c.op === 'strokeRect');
const texts = (ctx: MockCtx) =>
  ctx.calls.filter((c): c is Extract<CtxCall, { op: 'fillText' }> => c.op === 'fillText');

describe('rowType', () => {
  it('strips rows into bar/beat/sub/normal per TrackerEntry', () => {
    expect(rowType(0)).toBe('bar');
    expect(rowType(4)).toBe('beat');
    expect(rowType(2)).toBe('sub');
    expect(rowType(1)).toBe('normal');
    expect(rowType(16)).toBe('bar');
    expect(rowType(8)).toBe('beat');
  });
});

describe('drawStaticGrid', () => {
  it('paints one entry box per row × track in the drawn range', () => {
    const ctx = makeMockCtx();
    const tracks = [makeTrack([]), makeTrack([])];
    drawStaticGrid(ctx, layout(2, false, 8), theme, { tracks, endRow: 8 });
    // Track 0 boxes are 180px wide, 30px tall, one fill + one stroke each.
    const boxes = fills(ctx).filter((c) => c.x === 0 && c.height === 30);
    expect(boxes).toHaveLength(8);
    expect(boxes.every((c) => c.width === 180)).toBe(true);
    const secondTrack = fills(ctx).filter((c) => c.x === 190 && c.height === 30);
    expect(secondTrack).toHaveLength(8); // pitch = 180 + 10
    expect(strokes(ctx).length).toBeGreaterThanOrEqual(16);
  });

  it('stripes empty rows at 0 (bar), 4 (beat), 2 (sub) with distinct theme colors', () => {
    const ctx = makeMockCtx();
    drawStaticGrid(ctx, layout(1, false, 6), theme, { tracks: [makeTrack([])], endRow: 6 });
    const bgFor = (row: number) =>
      fills(ctx).find((c) => c.y === row * 36 && c.height === 30)!.fillStyle;
    expect(bgFor(0)).toBe(theme.rowBar);
    expect(bgFor(4)).toBe(theme.rowBeat);
    expect(bgFor(2)).toBe(theme.rowSub);
    expect(bgFor(1)).toBe(theme.entryBase);
    expect(bgFor(0)).not.toBe(theme.rowBeat);
  });

  it('paints borders per stripe class', () => {
    const ctx = makeMockCtx();
    drawStaticGrid(ctx, layout(1, false, 6), theme, { tracks: [makeTrack([])], endRow: 6 });
    const borderFor = (row: number) =>
      strokes(ctx).find((c) => c.y === row * 36 && c.height === 30)!.strokeStyle;
    expect(borderFor(0)).toBe(theme.borderBar);
    expect(borderFor(4)).toBe(theme.borderBeat);
    expect(borderFor(2)).toBe(theme.borderDefault);
  });

  it('stripes win over filled on striped rows; filled shows on plain rows; selection overrides both', () => {
    // TrackerEntry's CSS cascade: `.row-*:not(.active):not(.selected)` beats
    // `.filled`, so a filled bar row still paints the stripe; the filled
    // tint only surfaces on plain rows, which have no stripe class.
    const ctx = makeMockCtx();
    const entry0: TrackerEntryData = { row: 0, note: 'C-4' };
    const entry1: TrackerEntryData = { row: 1, note: 'C-4' };
    drawStaticGrid(
      ctx,
      layout(1, false, 2),
      theme,
      { tracks: [makeTrack([entry0, entry1])], endRow: 2 },
    );
    expect(fills(ctx).find((c) => c.y === 0)!.fillStyle).toBe(theme.rowBar);
    expect(fills(ctx).find((c) => c.y === 36)!.fillStyle).toBe(theme.entryFilled);

    const ctxSel = makeMockCtx();
    const selection: TrackerSelectionRect = { rowStart: 0, rowEnd: 0, trackStart: 0, trackEnd: 0 };
    drawStaticGrid(
      ctxSel,
      layout(1, false, 2),
      theme,
      { tracks: [makeTrack([entry0])], endRow: 1, selection },
    );
    expect(fills(ctxSel).find((c) => c.y === 0)!.fillStyle).toBe(theme.selectedBg);
    expect(strokes(ctxSel).find((c) => c.y === 0)!.strokeStyle).toBe(theme.selectedBorder);
  });

  it("renders '###' for release notes and pads short volume/macro strings", () => {
    const ctx = makeMockCtx();
    const entry: TrackerEntryData = { row: 0, note: '###', volume: 'F', macro: 'A' };
    drawStaticGrid(
      ctx,
      layout(1, false, 1),
      theme,
      { tracks: [makeTrack([entry])], endRow: 1 },
    );
    const drawn = texts(ctx).map((c) => c.text);
    // Volume is drawn as two single-char spans ('F' padded to 'F.'), macro
    // nibbles as three padded digit spans ('A..' → A . .).
    expect(drawn).toContain('###');
    expect(drawn).toContain('F');
    // '.' glyph calls: macro2+macro3 pads + volumeLo
    expect(drawn.filter((t) => t === '.')).toHaveLength(3);
    expect(drawn).toContain('A');
    expect(drawn).toContain('..'); // instrument default
  });

  it('draws --- / .. / . for empty entries', () => {
    const ctx = makeMockCtx();
    drawStaticGrid(
      ctx,
      layout(1, false, 1),
      theme,
      { tracks: [makeTrack([])], endRow: 1 },
    );
    const drawn = texts(ctx).map((c) => c.text);
    expect(drawn).toContain('---');
    expect(drawn).toContain('..');
    expect(drawn.filter((t) => t === '.')).toHaveLength(5); // volHi/Lo + 3 macros
  });

  it('tints linear and exponential interpolation ranges', () => {
    const ctx = makeMockCtx();
    const track = makeTrack([]);
    track.interpolations = [
      { startRow: 0, endRow: 1, macroIndex: 0, startValue: 0, endValue: 1, interpolation: 'linear' },
      { startRow: 2, endRow: 2, macroIndex: 0, startValue: 0, endValue: 1, interpolation: 'exponential' },
    ];
    drawStaticGrid(ctx, layout(1, false, 3), theme, { tracks: [track], endRow: 3 });
    const tints = fills(ctx).filter((c) => c.fillStyle === theme.interpolatedLinear);
    const expTints = fills(ctx).filter((c) => c.fillStyle === theme.interpolatedExponential);
    expect(tints).toHaveLength(2); // rows 0 and 1
    expect(tints[0]).toMatchObject({ y: 0 });
    expect(expTints).toHaveLength(1);
    expect(expTints[0]).toMatchObject({ y: 2 * 36 });
  });
});

describe('drawEntryBox', () => {
  it('lays macro digits on even thirds, matching the hit-test/cursor subdivision', () => {
    const entry: TrackerEntryData = { row: 0, macro: 'ABC' };
    const track = makeTrack([entry]);
    const ctx = makeMockCtx();
    drawEntryBox(ctx, 0, 0, layout(1, false, 1), theme, track, entry, undefined, false);

    // The cursor cell and the hit test both split the effect column into
    // plain thirds; the digits must sit on exactly those boundaries so the
    // digit under the pointer is the digit the cursor highlights.
    const trackWidth = trackWidthPx(1, false);
    const offsets = columnFractionOffsets(trackWidth, false);
    const nibbleWidth = macroNibbleWidth(trackWidth, false);
    const digitX = (i: number) => entryHorizontalInsetPx + offsets[4]! + i * nibbleWidth;
    const digits = texts(ctx).filter((c) => ['A', 'B', 'C'].includes(c.text));
    expect(digits.map((d) => d.x)).toEqual([digitX(0), digitX(1), digitX(2)]);
  });

  it('draws macro2 digits only when showExtraEffectColumn is set', () => {
    const entry: TrackerEntryData = { row: 0, macro: 'ABC', macro2: 'DEF' };
    const track = makeTrack([entry]);

    const ctxSingle = makeMockCtx();
    drawEntryBox(ctxSingle, 0, 0, layout(1, false, 1), theme, track, entry, undefined, false);
    const single = texts(ctxSingle).map((c) => c.text);
    expect(single).toEqual(expect.arrayContaining(['A', 'B', 'C']));
    expect(single).not.toContain('D');

    const ctxDual = makeMockCtx();
    drawEntryBox(ctxDual, 0, 0, layout(1, true, 1), theme, track, entry, undefined, false);
    const dual = texts(ctxDual).map((c) => c.text);
    expect(dual).toEqual(expect.arrayContaining(['A', 'B', 'C', 'D', 'E', 'F']));
  });

  it('uses the per-track accent for borders only via theme when selected', () => {
    const entry: TrackerEntryData = { row: 0, note: 'C-4' };
    const track = makeTrack([entry], '#ff0000');
    expect(trackAccent(track)).toBe('#ff0000');
    expect(trackAccent(makeTrack([]))).toBe('#5dd6ff');
  });
});

/**
 * The draw ops skip a `ctx.font` write when the value is already set, which
 * is worth several thousand font parses on a full-grid paint -- and is only
 * safe while the memo can never claim a font the context does not have. A
 * stale claim is invisible in the geometry and shows up as a whole column
 * of cells drawn in the wrong weight, so the weight is asserted per glyph
 * across a multi-cell paint rather than on one cell.
 */
describe('cell text weights survive the font memo', () => {
  const regular = `12px ${theme.fontTracker}`;
  const bold = `700 12px ${theme.fontTracker}`;

  it('keeps note and macro digits bold and instrument/volume regular on every cell', () => {
    const ctx = makeMockCtx();
    const entry: TrackerEntryData = {
      row: 1,
      note: 'C-4',
      instrument: '01',
      volume: '40',
      macro: 'A12',
    };
    drawStaticGrid(ctx, layout(2, false, 4), theme, {
      tracks: [makeTrack([entry]), makeTrack([{ ...entry, row: 2 }])],
      endRow: 4,
    });

    const drawn = texts(ctx);
    // 2 tracks x 4 rows x (note + instrument + 2 volume + 3 macro digits).
    expect(drawn).toHaveLength(2 * 4 * 7);
    for (const call of drawn) {
      expect(call.font).toBe(call.fillStyle === theme.instrumentText || call.fillStyle === theme.volumeText ? regular : bold);
    }
  });

  it('does not leak the gutter\'s font into the cells painted after it', () => {
    // drawRowNumbers writes the context's font itself, outside the memo.
    const ctx = makeMockCtx();
    drawRowNumbers(ctx, layout(1, false, 2), theme, {});
    drawStaticGrid(ctx, layout(1, false, 2), theme, {
      tracks: [makeTrack([{ row: 0, note: 'C-4' }])],
      endRow: 2,
    });

    const notes = texts(ctx).filter((c) => c.fillStyle === theme.noteText);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((c) => c.font === bold)).toBe(true);
  });
});

describe('drawRowNumbers', () => {
  it('paints hex labels in a 78px gutter', () => {
    const ctx = makeMockCtx();
    drawRowNumbers(ctx, layout(1, false, 20), theme, { endRow: 20 });
    const drawn = texts(ctx).map((c) => c.text);
    expect(drawn[0]).toBe('00');
    expect(drawn).toContain('04');
    expect(drawn).toContain('0A');
    expect(drawn).toContain('10'); // row 16 in hex
    const gutter = fills(ctx).find((c) => c.width === 78 && c.x === 0);
    expect(gutter).toBeDefined();
    expect(gutter!.height).toBe(30);
    // Row-number text uses the muted color.
    expect(texts(ctx)[0]!.fillStyle).toBe(theme.rowNumberText);
  });
});

describe('drawSelectionBar', () => {
  it('paints one bar per selected row with the selected theme colors', () => {
    const ctx = makeMockCtx();
    const selection: TrackerSelectionRect = { rowStart: 2, rowEnd: 3, trackStart: 0, trackEnd: 1 };
    drawSelectionBar(ctx, layout(2, false, 8), theme, { selection });
    const painted = fills(ctx);
    expect(painted).toHaveLength(2);
    expect(painted[0]).toMatchObject({ y: 2 * 36, height: 30, fillStyle: theme.selectedBg });
    expect(painted[1]!.y).toBe(3 * 36);
    expect(strokes(ctx).every((c) => c.strokeStyle === theme.selectedBorder)).toBe(true);
  });
});

describe('drawActiveRowBar', () => {
  const layout4 = layout(4, false, 32);

  it('paints the tracks pill with the DOM fill/stroke values and 2px border', () => {
    const ctx = makeMockCtx();
    drawActiveRowBar(ctx, layout4, theme, { playbackRow: 7, mode: 'pattern' });
    // Two rounded pills (tracks + row-number gutter), both carrying the
    // DOM's exact values: fill var(--tracker-selected-bg), stroke
    // var(--tracker-accent-primary) at 2px — .playback-pattern's styles.
    const pills = paths(ctx);
    expect(pills).toHaveLength(2);
    for (const pill of pills) {
      expect(pill.y).toBe(7 * 36);
      expect(pill.height).toBe(30);
      expect(pill.fillStyle).toBe(theme.selectedBg);
      expect(pill.strokeStyle).toBe(theme.accentPrimary);
      expect(pill.radius).toBe(10); // the DOM's border-radius
    }
    const tracksPill = pills.find((c) => c.width === activeRowBarWidthPx(4, false)!);
    expect(tracksPill).toBeDefined();
    // Border is 2px per .row-playback-bar, recorded at trace time.
    expect(pills.every((p) => p.lineWidth === 2)).toBe(true);
  });

  it('uses the song-mode colors the DOM hard-codes for .playback-song', () => {
    const ctx = makeMockCtx();
    drawActiveRowBar(ctx, layout4, theme, { playbackRow: 0, mode: 'song' });
    expect(theme.accentSecondary).toBe('rgb(88, 176, 255)');
    for (const pill of paths(ctx)) {
      expect(pill.strokeStyle).toBe(theme.accentSecondary);
      expect(pill.fillStyle).toBe('rgba(88, 176, 255, 0.14)');
    }
  });

  it('adds the row-number gutter pill pinned to the viewport edge (gutterScrollX)', () => {
    const ctx = makeMockCtx();
    drawActiveRowBar(ctx, layout4, theme, {
      playbackRow: 3,
      mode: 'pattern',
      gutterScrollX: 120,
    });
    // The overlay layer is translated by (GUTTER − viewLeft): passing
    // viewLeft as gutterScrollX pins the segment to the viewport's left
    // edge — the DOM's non-scrolling .row-playback-bar behavior.
    const gutter = paths(ctx).find((c) => c.width === 78);
    expect(gutter).toBeDefined();
    expect(gutter!.x).toBe(120 - 78);
    expect(gutter!.y).toBe(3 * 36);
    expect(gutter!.height).toBe(30);
  });

  it('falls back to the full pattern width when trackCount is 0', () => {
    const ctx = makeMockCtx();
    drawActiveRowBar(ctx, layout(4, false, 32), theme, {
      playbackRow: 1,
      mode: 'pattern',
      trackCount: 0,
    });
    // totalPatternWidth(4 tracks) = 3 pitches + one width, no trailing gap.
    const tracksPill = paths(ctx).find((c) => c.width === 3 * (180 + 10) + 180);
    expect(tracksPill).toBeDefined();
  });
});

describe('buildInterpolatedRows', () => {
  it('builds a row→type map like TrackerTrack.interpolatedRows', () => {
    const track = makeTrack([]);
    track.interpolations = [
      { startRow: 2, endRow: 4, macroIndex: 0, startValue: 0, endValue: 1, interpolation: 'exponential' },
    ];
    const map = buildInterpolatedRows(track);
    expect(map[2]).toBe('exponential');
    expect(map[4]).toBe('exponential');
    expect(map[5]).toBeUndefined();
  });
});

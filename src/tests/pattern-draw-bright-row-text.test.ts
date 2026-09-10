import { describe, it, expect } from 'vitest';
import {
  drawBrightRowNumbers,
  drawBrightRowText,
  drawEntryBox,
} from 'src/components/tracker/pattern-canvas/pattern-draw';
import { GUTTER_WIDTH_PX } from 'src/components/tracker/pattern-canvas/pattern-layout';
import type { PatternTheme } from 'src/components/tracker/pattern-canvas/pattern-theme';
import { buildTrackAccents } from 'src/components/tracker/pattern-canvas/track-accents';
import type { TrackerEntryData, TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * The bright playing-row TEXT pre-render (task: light up the playing row's
 * text, nothing behind it). A call-recording 2D-context mock (same approach
 * as pattern-draw.test.ts) pins that the pre-render:
 *  - recolours every glyph to ONE theme-derived colour,
 *  - lays each glyph out on the exact pixels drawEntryBox uses (so the strip
 *    blits pixel-aligned over the static text), and
 *  - paints no fills — no background, no border, no interpolation tint.
 */

interface TextCall {
  op: 'fillText';
  text: string;
  x: number;
  y: number;
  fillStyle: string;
  font: string;
}
interface RectCall {
  op: 'fillRect' | 'strokeRect';
  x: number;
  y: number;
  width: number;
  height: number;
  fillStyle: string;
}
type CtxCall = TextCall | RectCall;

function makeMockCtx() {
  const calls: CtxCall[] = [];
  const props: Record<string, unknown> = {};
  const ctx = {
    calls,
    props,
    fill() {},
    stroke() {},
    save() {},
    restore() {},
    beginPath() {},
    clip() {},
    translate() {},
    setTransform() {},
    clearRect() {},
    measureText() {
      return { width: 10 };
    },
    fillRect(x: number, y: number, width: number, height: number) {
      calls.push({
        op: 'fillRect',
        x,
        y,
        width,
        height,
        fillStyle: String(props.fillStyle ?? ''),
      });
    },
    strokeRect(x: number, y: number, width: number, height: number) {
      calls.push({
        op: 'strokeRect',
        x,
        y,
        width,
        height,
        fillStyle: String(props.fillStyle ?? ''),
      });
    },
    fillText(text: string, x: number, y: number) {
      calls.push({
        op: 'fillText',
        text,
        x,
        y,
        fillStyle: String(props.fillStyle ?? ''),
        font: String(props.font ?? ''),
      });
    },
  };
  return new Proxy(ctx as unknown as CanvasRenderingContext2D, {
    get(target, key: string) {
      if (key in target) return (target as unknown as Record<string, unknown>)[key];
      return props[key];
    },
    set(target, key: string, value) {
      if (key in target) {
        (target as unknown as Record<string, unknown>)[key] = value;
      } else {
        props[key] = value;
      }
      return true;
    },
  }) as CanvasRenderingContext2D & { calls: CtxCall[] };
}

type MockCtx = ReturnType<typeof makeMockCtx>;

const BRIGHT = '#bada55';

/** Sentinel palette: every text token is distinct, none equal to BRIGHT. */
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
  noteText: '#note-sentinel',
  instrumentText: '#instr-sentinel',
  volumeText: '#vol-sentinel',
  effectText: '#fx-sentinel',
  defaultText: '#def-sentinel',
  rowNumberText: '#rownum-sentinel',
  interpolatedLinear: 'rgba(77, 242, 197, 0.08)',
  interpolatedExponential: 'rgba(158, 197, 255, 0.1)',
  panelBackground: '#0a0e16',
  fontTracker: "'JetBrains Mono', monospace",
  trackAccents: buildTrackAccents('rgb(77, 242, 197)', 'rgb(88, 176, 255)'),
};

const layout = (trackCount = 2, showExtraEffectColumn = false, rowCount = 8) => ({
  trackCount,
  showExtraEffectColumn,
  rowCount,
});

function makeTrack(id: string, entries: TrackerEntryData[]): TrackerTrackData {
  return { id, name: id.toUpperCase(), entries };
}

const texts = (ctx: MockCtx) => ctx.calls.filter((c): c is TextCall => c.op === 'fillText');
const rects = (ctx: MockCtx) =>
  ctx.calls.filter((c): c is RectCall => c.op === 'fillRect' || c.op === 'strokeRect');

describe('drawBrightRowText', () => {
  const entries: TrackerEntryData[] = [
    { row: 0, note: 'C-4', instrument: '01', volume: '40', macro: 'A05' },
    { row: 2, note: 'D-5', instrument: '03' },
  ];

  it('recolours every glyph to the one supplied colour, never a per-column token', () => {
    const ctx = makeMockCtx();
    drawBrightRowText(ctx, layout(2, false, 8), theme, {
      tracks: [makeTrack('t0', entries), makeTrack('t1', [])],
      color: BRIGHT,
    });
    const drawn = texts(ctx);
    expect(drawn.length).toBeGreaterThan(0);
    for (const t of drawn) expect(t.fillStyle).toBe(BRIGHT);
    // None of the normal per-column text tokens leaked through.
    const leaked = drawn.filter((t) =>
      [theme.noteText, theme.instrumentText, theme.volumeText, theme.effectText].includes(
        t.fillStyle,
      ),
    );
    expect(leaked).toHaveLength(0);
  });

  it('defaults the bright colour to the theme note-text token', () => {
    const ctx = makeMockCtx();
    drawBrightRowText(ctx, layout(1, false, 4), theme, {
      tracks: [makeTrack('t0', entries)],
    });
    const drawn = texts(ctx);
    expect(drawn.length).toBeGreaterThan(0);
    for (const t of drawn) expect(t.fillStyle).toBe(theme.noteText);
  });

  it('paints text only — no fills, no borders, no interpolation tint', () => {
    const ctx = makeMockCtx();
    drawBrightRowText(ctx, layout(1, false, 4), theme, {
      tracks: [
        {
          ...makeTrack('t0', entries),
          interpolations: [
            {
              startRow: 0,
              endRow: 3,
              macroIndex: 0,
              startValue: 0,
              endValue: 1,
              interpolation: 'linear',
            },
          ],
        },
      ],
      color: BRIGHT,
    });
    expect(rects(ctx)).toHaveLength(0);
  });

  it('lays each glyph out on the exact pixels drawEntryBox uses (blit alignment)', () => {
    const l = layout(2, false, 8);
    const tracks = [makeTrack('t0', entries), makeTrack('t1', [])];

    const boxCtx = makeMockCtx();
    drawEntryBox(boxCtx, 0, 0, l, theme, tracks[0]!, entries[0], undefined, false);
    const boxNote = texts(boxCtx).find((t) => t.fillStyle === theme.noteText);

    const brightCtx = makeMockCtx();
    drawBrightRowText(brightCtx, l, theme, { tracks, color: BRIGHT, startRow: 0, endRow: 1 });
    const brightNote = texts(brightCtx)[0];

    expect(boxNote).toBeDefined();
    expect(brightNote).toBeDefined();
    expect(brightNote!.text).toBe(boxNote!.text);
    expect(brightNote!.x).toBeCloseTo(boxNote!.x, 6);
    expect(brightNote!.y).toBeCloseTo(boxNote!.y, 6);
  });

  it('honours the row range', () => {
    const ctx = makeMockCtx();
    drawBrightRowText(ctx, layout(1, false, 8), theme, {
      tracks: [makeTrack('t0', entries)],
      color: BRIGHT,
      startRow: 2,
      endRow: 3,
    });
    // Row 2 is the D-5 entry; row 0's C-4 must not appear.
    const drawn = texts(ctx).map((t) => t.text);
    expect(drawn).toContain('D-5');
    expect(drawn).not.toContain('C-4');
  });
});

describe('drawBrightRowNumbers', () => {
  it('draws the hex gutter labels in the bright colour, no pill fill or border', () => {
    const ctx = makeMockCtx();
    drawBrightRowNumbers(ctx, layout(2, false, 4), theme, { color: BRIGHT });
    const drawn = texts(ctx);
    expect(drawn.map((t) => t.text)).toEqual(['00', '01', '02', '03']);
    for (const t of drawn) {
      expect(t.fillStyle).toBe(BRIGHT);
      expect(t.x).toBeCloseTo(GUTTER_WIDTH_PX / 2, 6);
    }
    expect(rects(ctx)).toHaveLength(0);
  });

  it('defaults to the theme note-text token', () => {
    const ctx = makeMockCtx();
    drawBrightRowNumbers(ctx, layout(1, false, 2), theme, {});
    for (const t of texts(ctx)) expect(t.fillStyle).toBe(theme.noteText);
  });
});

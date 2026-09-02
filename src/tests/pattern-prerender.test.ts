import { describe, expect, it } from 'vitest';
import {
  canAdoptPreRender,
  metaFromInfo,
  paintUpcoming,
  preRenderExtent,
} from 'src/components/tracker/pattern-canvas/pattern-prerender';
import { GUTTER_WIDTH_PX } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { totalTracksWidth } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { setCache } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { PatternTheme } from 'src/components/tracker/pattern-canvas/pattern-theme';
import type { UpcomingPatternInfo } from 'src/components/tracker/pattern-buffering';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

/**
 * Pure tests for the upcoming-pattern pre-render (§3.2): the bitmap extent
 * it needs, what paintUpcoming draws, and when a finished pre-render may be
 * adopted at a swap (pointer swap, no full repaint).
 */

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

setCache(theme);

function makeTrack(id: string, rows: number[]): TrackerTrackData {
  return { id, name: `Track ${id}`, entries: rows.map((row) => ({ row, note: 'C-4' })) };
}

function makeInfo(id: string, tracks: TrackerTrackData[], rows = 32): UpcomingPatternInfo {
  return { id, tracks, rows };
}

// Recording context: paintUpcoming takes any surface with getContext('2d').
function makeRecordingSurface(width: number, height: number) {
  const calls: string[] = [];
  const surface = {
    width,
    height,
    getContext() {
      return {
        clearRect: () => calls.push('clear'),
        fillRect: () => calls.push('fill'),
        strokeRect: () => calls.push('strokeRect'),
        save: () => calls.push('save'),
        restore: () => calls.push('restore'),
        translate: () => calls.push('translate'),
        fillStyle: '',
        font: '',
        textAlign: '',
        textBaseline: '',
        lineWidth: 1,
        strokeStyle: '',
        beginPath: () => calls.push('path'),
        moveTo: () => {},
        lineTo: () => {},
        arc: () => {},
        arcTo: () => {},
        closePath: () => {},
        stroke: () => calls.push('stroke'),
        fill: () => calls.push('fillPath'),
        rect: () => {},
        roundRect: () => {},
        fillText: () => {},
        measureText: () => ({ width: 10 }),
        clip: () => {},
      };
    },
  };
  return { surface: surface as unknown as OffscreenCanvas, calls };
}

describe('preRenderExtent', () => {
  it('is the gutter plus every track column, by the pattern row count', () => {
    const info = makeInfo('p1', [makeTrack('a', []), makeTrack('b', [])], 64);
    expect(preRenderExtent(info, false)).toEqual({
      width: GUTTER_WIDTH_PX + totalTracksWidth(2, false),
      height: 64 * 36, // rowPitchPx
    });
  });
});

describe('paintUpcoming', () => {
  it('paints the full static grid (gutter + tracks) and reports success', () => {
    const info = makeInfo('p1', [makeTrack('a', [0, 1]), makeTrack('b', [2])]);
    const { surface, calls } = makeRecordingSurface(400, 1200);
    expect(paintUpcoming(surface, info, false, null)).toBe(true);
    // Same shape as paintStatic: background fill, gutter rows, translated
    // track grid, selection overlay skipped when nothing is selected.
    expect(calls[0]).toBe('clear');
    expect(calls[1]).toBe('fill');
    expect(calls).toContain('restore');
  });

  it('returns false when the surface has no 2D context', () => {
    const info = makeInfo('p1', [makeTrack('a', [])]);
    const surface = {
      width: 100,
      height: 100,
      getContext: () => null,
    } as unknown as OffscreenCanvas;
    expect(paintUpcoming(surface, info, false, null)).toBe(false);
  });

  it('bakes the selection overlay in when one is active', () => {
    const info = makeInfo('p1', [makeTrack('a', [0])]);
    const selection = { rowStart: 0, rowEnd: 1, trackStart: 0, trackEnd: 0 };
    const { surface } = makeRecordingSurface(400, 1200);
    // No direct assertion on pixels — the overlay op sequence mirrors
    // paintStatic's; the component test pins the swap behavior end to end.
    expect(paintUpcoming(surface, info, false, selection)).toBe(true);
  });
});

describe('canAdoptPreRender', () => {
  const tracks = [makeTrack('a', [0, 1]), makeTrack('b', [2])];
  const info = makeInfo('p1', tracks);
  const meta = metaFromInfo(info, false, null);

  it('adopts when the arriving props match the painted content', () => {
    // The swap arrives with the pattern's tracks/rows as the new props.
    expect(canAdoptPreRender(meta, tracks, 32, false, null)).toBe(true);
  });

  it('rejects when there is no meta or no arriving content', () => {
    expect(canAdoptPreRender(null, tracks, 32, false, null)).toBe(false);
    expect(canAdoptPreRender(meta, null, 32, false, null)).toBe(false);
  });

  it('rejects a different pattern (stale pre-render)', () => {
    const other = makeInfo('p2', [makeTrack('a', [0]), makeTrack('b', [1])]);
    expect(canAdoptPreRender(meta, other.tracks, other.rows, false, null)).toBe(false);
  });

  it('rejects after an edit replaced entry objects on the upcoming pattern', () => {
    const edited = [makeTrack('a', [0, 1]), makeTrack('b', [2])];
    // Same pattern id and rows, but the keystroke replaced entry objects.
    expect(canAdoptPreRender(meta, edited, 32, false, null)).toBe(false);
  });

  it('rejects a row-count or dual-effect change', () => {
    expect(canAdoptPreRender(meta, tracks, 64, false, null)).toBe(false);
    expect(canAdoptPreRender(meta, tracks, 32, true, null)).toBe(false);
  });

  it('rejects a selection change since the swap would paint without it', () => {
    const selection = { rowStart: 0, rowEnd: 1, trackStart: 0, trackEnd: 1 };
    expect(canAdoptPreRender(meta, tracks, 32, false, selection)).toBe(false);
    const metaSel = metaFromInfo(info, false, selection);
    expect(canAdoptPreRender(metaSel, tracks, 32, false, { ...selection })).toBe(true);
  });

  it('rejects a track-count change', () => {
    expect(canAdoptPreRender(meta, [tracks[0]!], 32, false, null)).toBe(false);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import type { AhxInstrument } from '@another-synth/tracker-playback';

vi.mock('src/components/tracker/pattern-canvas/PatternCanvas.vue', async () => ({
  default: (await import('./helpers/pattern-canvas-stub')).PatternCanvasStub,
}));

import PListCanvas from 'src/components/ahx/PListCanvas.vue';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import { stubLog } from './helpers/pattern-canvas-stub';
import { plistLegendCells, PLIST_TRACK_WIDTH_PX } from 'src/components/ahx/plist-legend';
import { columnFractionOffsets, entryHorizontalInsetPx, GUTTER_WIDTH_PX } from 'src/components/tracker/pattern-canvas/pattern-layout';
import { defaultAhxInstrument } from 'src/audio/tracker/ahx-instrument-edit';

/**
 * T6: the PList canvas host (batch B3, static). What jsdom can assert: the
 * props the host hands `PatternCanvas`, the legend, the events and keys. What
 * it can not (pixels, real scroll and DPR) is the browser check.
 */
const rowsOf = (n: number): AhxInstrument['plist']['entries'] =>
  Array.from({ length: n }, (_, i) => ({ note: i + 1, waveform: (i % 4) + 1, fixed: i % 2 === 0, fx: [0, 0] as [number, number], fxParam: [0, 0] as [number, number] }));
const instrumentWith = (n: number): AhxInstrument => {
  const ins = defaultAhxInstrument();
  ins.plist = { speed: 2, entries: rowsOf(n) };
  return ins;
};

function host(props: { instrument: AhxInstrument | null; selected?: number | null; playheadRow?: number }) {
  return mount(PListCanvas, { props: { selected: null, ...props }, attachTo: document.body });
}
const canvas = (w: ReturnType<typeof host>) => w.findComponent(PatternCanvas);
const canvasProp = (w: ReturnType<typeof host>, name: string): unknown => (canvas(w).props() as unknown as Record<string, unknown>)[name];

beforeEach(() => {
  stubLog.trackChanges = 0;
  document.body.innerHTML = '';
});

describe('the props the host gives PatternCanvas', () => {
  it('draws one dual-effect track with a row per step, no cursor, no trail and no analyser gutter', () => {
    const w = host({ instrument: instrumentWith(12) });
    expect(canvasProp(w, 'rows')).toBe(12);
    expect(canvasProp(w, 'showExtraEffectColumn')).toBe(true);
    expect(canvasProp(w, 'showTrail')).toBe(false);
    expect(canvasProp(w, 'activeTrack')).toBe(-1);
    expect(canvasProp(w, 'reserveSideGutter')).toBe(false);
    expect(canvasProp(w, 'playbackMode')).toBe('pattern');
    expect(canvasProp(w, 'autoScroll')).toBe(true);
    const tracks = canvasProp(w, 'tracks') as { name: string; entries: unknown[] }[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.name).toBe('PList');
    expect(tracks[0]!.entries).toHaveLength(12);
    w.unmount();
  });

  it('has no playhead: playbackRow -1 and not playing', () => {
    const w = host({ instrument: instrumentWith(4) });
    expect(canvasProp(w, 'playbackRow')).toBe(-1);
    expect(canvasProp(w, 'isPlaying')).toBe(false);
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-playhead-row')).toBe('-1');
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-playing')).toBe('false');
    w.unmount();
  });

  it('carries the seam for the playhead: a valid row drives the pill, a row the list no longer has does not', async () => {
    const w = host({ instrument: instrumentWith(4), playheadRow: 2 });
    expect(canvasProp(w, 'playbackRow')).toBe(2);
    expect(canvasProp(w, 'isPlaying')).toBe(true);
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-playhead-row')).toBe('2');
    await w.setProps({ playheadRow: 4 });
    expect(canvasProp(w, 'playbackRow')).toBe(-1);
    expect(canvasProp(w, 'isPlaying')).toBe(false);
    await w.setProps({ playheadRow: 99 });
    expect(canvasProp(w, 'playbackRow')).toBe(-1);
    w.unmount();
  });

  it('highlights the selected step through the canvas selection bar, and none when nothing (or nothing valid) is selected', async () => {
    const w = host({ instrument: instrumentWith(6), selected: 3 });
    expect(canvasProp(w, 'selectionRect')).toEqual({ rowStart: 3, rowEnd: 3, trackStart: 0, trackEnd: 0 });
    expect(canvasProp(w, 'selectedRow')).toBe(3);
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-selected-row')).toBe('3');
    await w.setProps({ selected: null });
    expect(canvasProp(w, 'selectionRect')).toBeNull();
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-selected-row')).toBe('-1');
    await w.setProps({ selected: 6 });
    expect(canvasProp(w, 'selectionRect')).toBeNull();
    w.unmount();
  });

  it('shows at most eight rows before it scrolls (the panel is as tall as its rows below that)', () => {
    const small = host({ instrument: instrumentWith(3) });
    const big = host({ instrument: instrumentWith(200) });
    const heightOf = (w: ReturnType<typeof host>) => parseInt((w.get('.plist-canvas__stage').element as HTMLElement).style.height, 10);
    expect(heightOf(big) - heightOf(small)).toBe((8 - 3) * 36);
    small.unmount();
    big.unmount();
  });
});

describe('the legend', () => {
  it('names the four columns over the canvas geometry, with a native tooltip each', () => {
    const w = host({ instrument: instrumentWith(2) });
    const cells = plistLegendCells(PLIST_TRACK_WIDTH_PX);
    expect(cells.map((c) => c.label)).toEqual(['Note', 'Tone', 'Command 1', 'Command 2']);
    const offsets = columnFractionOffsets(PLIST_TRACK_WIDTH_PX, true);
    const wanted = { note: 0, tone: 1, cmd1: 4, cmd2: 5 } as const;
    for (const cell of cells) {
      const node = w.get(`[data-testid="ahx-plist-canvas-legend-${cell.key}"]`);
      expect(node.text()).toBe(cell.label);
      expect(node.attributes('title')).toBe(cell.title);
      expect(cell.title.length).toBeGreaterThan(30);
      const column = wanted[cell.key];
      expect(cell.x).toBeCloseTo(GUTTER_WIDTH_PX + entryHorizontalInsetPx + offsets[column]!, 6);
      expect(cell.width).toBeCloseTo(offsets[column + 1]! - offsets[column]!, 6);
      expect((node.element as HTMLElement).style.left).toBe(`${cell.x}px`);
    }
    w.unmount();
  });

  it('says only what the projection draws: the tone tags and the note forms', () => {
    const titles = Object.fromEntries(plistLegendCells().map((c) => [c.key, c.title]));
    expect(titles.tone).toMatch(/TR triangle, SA sawtooth, SQ square, NO noise/);
    expect(titles.note).toMatch(/\+05 is 5 semitones above the key played/);
    expect(titles.note).toMatch(/C-2 is a fixed pitch/);
  });
});

describe('selection by pointer', () => {
  it('a row click and a cell click both select that step', async () => {
    const w = host({ instrument: instrumentWith(6) });
    canvas(w).vm.$emit('rowSelected', 4);
    canvas(w).vm.$emit('cellSelected', { row: 2, column: 1, trackIndex: 0 });
    expect(w.emitted('select')).toEqual([[4], [2]]);
    w.unmount();
  });

  it('ignores a row the list does not have', () => {
    const w = host({ instrument: instrumentWith(3) });
    canvas(w).vm.$emit('rowSelected', 3);
    canvas(w).vm.$emit('rowSelected', -1);
    expect(w.emitted('select')).toBeUndefined();
    w.unmount();
  });

  it('takes focus on a click, so the arrow keys work at once', () => {
    const w = host({ instrument: instrumentWith(3) });
    canvas(w).vm.$emit('rowSelected', 1);
    expect(document.activeElement).toBe(w.get('[data-testid="ahx-plist-canvas"]').element);
    w.unmount();
  });
});

describe('keyboard navigation', () => {
  const press = async (w: ReturnType<typeof host>, key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    const stop = vi.spyOn(event, 'stopPropagation');
    w.get('[data-testid="ahx-plist-canvas"]').element.dispatchEvent(event);
    await nextTick();
    return { event, stopped: stop.mock.calls.length > 0 };
  };
  const selectedAfter = async (n: number, selected: number | null, key: string): Promise<number | null> => {
    const w = host({ instrument: instrumentWith(n), selected });
    await press(w, key);
    const emitted = w.emitted('select');
    w.unmount();
    return emitted ? (emitted[0]![0] as number) : null;
  };

  it('moves the selection with the arrows, clamped at both ends', async () => {
    expect(await selectedAfter(20, 5, 'ArrowDown')).toBe(6);
    expect(await selectedAfter(20, 5, 'ArrowUp')).toBe(4);
    expect(await selectedAfter(20, 19, 'ArrowDown')).toBe(19);
    expect(await selectedAfter(20, 0, 'ArrowUp')).toBe(0);
  });

  it('Home, End, Page Up and Page Down jump (a page is the eight rows the card shows)', async () => {
    expect(await selectedAfter(50, 20, 'Home')).toBe(0);
    expect(await selectedAfter(50, 20, 'End')).toBe(49);
    expect(await selectedAfter(50, 20, 'PageDown')).toBe(28);
    expect(await selectedAfter(50, 20, 'PageUp')).toBe(12);
    expect(await selectedAfter(50, 45, 'PageDown')).toBe(49);
    expect(await selectedAfter(50, 3, 'PageUp')).toBe(0);
  });

  it('with nothing selected, down starts at the first step and up at the last', async () => {
    expect(await selectedAfter(9, null, 'ArrowDown')).toBe(0);
    expect(await selectedAfter(9, null, 'ArrowUp')).toBe(8);
  });

  it('takes the keys it uses (default prevented, propagation stopped)', async () => {
    const w = host({ instrument: instrumentWith(5), selected: 1 });
    const { event, stopped } = await press(w, 'ArrowDown');
    expect(event.defaultPrevented).toBe(true);
    expect(stopped).toBe(true);
    w.unmount();
  });

  it('lets every other key through: the audition keys, Escape, Space, Enter', async () => {
    const w = host({ instrument: instrumentWith(5), selected: 1 });
    for (const [key, code] of [['a', 'KeyA'], ['q', 'KeyQ'], ['Escape', 'Escape'], [' ', 'Space'], ['Enter', 'Enter'], ['ArrowLeft', 'ArrowLeft'], ['ArrowRight', 'ArrowRight']] as const) {
      const { event, stopped } = await press(w, key, { code });
      expect(event.defaultPrevented, key).toBe(false);
      expect(stopped, key).toBe(false);
    }
    expect(w.emitted('select')).toBeUndefined();
    w.unmount();
  });

  it('lets a modified navigation key through (Shift+Page Up / Down is the octave shortcut)', async () => {
    const w = host({ instrument: instrumentWith(50), selected: 20 });
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]) {
      const { event, stopped } = await press(w, 'PageUp', init);
      expect(event.defaultPrevented).toBe(false);
      expect(stopped).toBe(false);
    }
    expect(w.emitted('select')).toBeUndefined();
    w.unmount();
  });
});

describe('the empty and failed states', () => {
  it('draws no canvas for an instrument with no PList rows, and says why', () => {
    const w = host({ instrument: instrumentWith(0) });
    expect(w.findComponent(PatternCanvas).exists()).toBe(false);
    expect(w.find('[data-testid="ahx-plist-canvas-legend"]').exists()).toBe(false);
    expect(w.get('[data-testid="ahx-plist-canvas-empty"]').text()).toMatch(/no steps/i);
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-rows')).toBe('0');
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('tabindex')).toBeUndefined();
    w.unmount();
  });

  it('treats a missing instrument as empty', () => {
    const w = host({ instrument: null });
    expect(w.find('[data-testid="ahx-plist-canvas-empty"]').exists()).toBe(true);
    w.unmount();
  });

  it('swaps to a message when the canvas renderer fails', async () => {
    const w = host({ instrument: instrumentWith(3) });
    canvas(w).vm.$emit('rendererError', new Error('no 2d context'));
    await nextTick();
    expect(w.find('[data-testid="ahx-plist-canvas-error"]').exists()).toBe(true);
    expect(w.findComponent(PatternCanvas).exists()).toBe(false);
    w.unmount();
  });

  it('comes back from empty when a row is added', async () => {
    const w = host({ instrument: instrumentWith(0) });
    await w.setProps({ instrument: instrumentWith(2) });
    expect(w.findComponent(PatternCanvas).exists()).toBe(true);
    expect(w.get('[data-testid="ahx-plist-canvas"]').attributes('data-rows')).toBe('2');
    w.unmount();
  });
});

describe('the caption', () => {
  it('states only what is built: rows, hex numbering, click and keys, and no claim of playback', () => {
    const w = host({ instrument: instrumentWith(2) });
    const text = w.get('[data-testid="ahx-plist-canvas-caption"]').text();
    expect(text).toMatch(/One row per step, numbered in hex/);
    expect(text).not.toMatch(/play|loop|seek|hear/i);
    w.unmount();
  });
});

describe('repaints: the track keeps its identity while the PList content does (T2 at the host)', () => {
  it('an instrument replaced with the same PList content does not change the tracks prop', async () => {
    const a = instrumentWith(8);
    const w = host({ instrument: a });
    const first = canvasProp(w, 'tracks');
    await nextTick();
    const before = stubLog.trackChanges;
    for (let i = 0; i < 5; i++) {
      const next = JSON.parse(JSON.stringify(a)) as AhxInstrument;
      next.volume = 10 + i; // an unrelated edit, as an envelope drag would make
      next.envelope.aFrames = i + 1;
      await w.setProps({ instrument: next });
    }
    expect(canvasProp(w, 'tracks')).toBe(first);
    expect(stubLog.trackChanges).toBe(before);
    w.unmount();
  });

  it('a PList edit changes the tracks prop exactly once', async () => {
    const a = instrumentWith(8);
    const w = host({ instrument: a });
    await nextTick();
    const before = stubLog.trackChanges;
    const next = JSON.parse(JSON.stringify(a)) as AhxInstrument;
    next.plist.entries[3]!.waveform = 1;
    await w.setProps({ instrument: next });
    expect(stubLog.trackChanges).toBe(before + 1);
    const track = (canvasProp(w, 'tracks') as { entries: { row: number; instrument?: string }[] }[])[0]!;
    expect(track.entries.find((e) => e.row === 3)!.instrument).toBe('TR');
    w.unmount();
  });
});

describe('native elements only (CLAUDE.md UI rules)', () => {
  it.each(['src/components/ahx/PListCanvas.vue', 'src/components/ahx/plist-legend.ts', 'src/audio/tracker/plist-track.ts'])(
    'no Quasar component or import in %s',
    (file) => {
      const source = readFileSync(resolve(__dirname, '../..', file), 'utf8');
      expect(source).not.toMatch(/<q-[a-z]/i);
      expect(source).not.toMatch(/from 'quasar'/);
    },
  );
});

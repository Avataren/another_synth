import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createClearSelectionOnPress,
  shouldClearSelectionOnPress,
} from 'src/composables/useClearSelectionOnOutsidePress';
import { useTrackerSelection } from 'src/composables/useTrackerSelection';
import type { TrackerSelectionContext } from 'src/composables/useTrackerSelection';
import type { TrackerPattern } from 'src/stores/tracker-store';

/**
 * A stand-in for the tracker page's structure: the container that carries the
 * pointerdown handler, with the surfaces the real page has inside it.
 */
const PAGE_HTML = `
  <div id="container" tabindex="0">
    <div class="tracker-toolbar" id="toolbar-gap">
      <button id="play-btn" type="button">Play</button>
      <input id="bpm" type="number" />
      <label id="lbl">BPM</label>
      <div class="q-field" id="q-select"><span id="q-select-text">Add Pattern</span></div>
    </div>
    <div class="top-grid" id="panel-gap">
      <div class="sequence-item" id="seq-row"><span id="seq-name">Pattern 1</span></div>
    </div>
    <div class="track-headers" id="header-gap">
      <button id="mute-btn" type="button">M</button>
      <canvas id="waveform"></canvas>
    </div>
    <div class="pattern-area-wrapper" id="wrapper-gap">
      <div class="pattern-area" data-selection-surface id="pattern-area">
        <canvas id="pattern-canvas"></canvas>
      </div>
      <div class="track-scrollbar" data-selection-surface id="scrollbar"></div>
    </div>
  </div>
`;

function makeSelection() {
  const pattern = {
    id: 'p1',
    name: 'P',
    rows: 8,
    tracks: [
      { id: 'T01', name: 'A', color: '#fff', entries: [] },
      { id: 'T02', name: 'B', color: '#fff', entries: [] },
    ],
  } as unknown as TrackerPattern;
  const context: TrackerSelectionContext = {
    activeRow: ref(0),
    activeTrack: ref(0),
    isEditMode: ref(false),
    rowsCount: ref(8),
    currentPattern: computed(() => pattern),
    pushHistory: vi.fn(),
    parseTrackerNoteSymbol: () => ({ isNoteOff: false }),
    midiToTrackerNote: (m) => `n${m}`,
  };
  return useTrackerSelection(context);
}

// jsdom has no PointerEvent; a MouseEvent of type pointerdown carries the same
// button and modifier fields the handler reads.
function press(el: Element, init: MouseEventInit = {}): Event {
  const event = new MouseEvent('pointerdown', { bubbles: true, button: 0, ...init });
  el.dispatchEvent(event);
  return event;
}

describe('clear tracker selection on a press outside the pattern grid', () => {
  let container: HTMLElement;
  let sel: ReturnType<typeof makeSelection>;
  let clear: ReturnType<typeof vi.fn>;

  const $ = (id: string) => document.getElementById(id) as HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = PAGE_HTML;
    container = $('container');
    sel = makeSelection();
    sel.onPatternStartSelection({ row: 1, trackIndex: 0 });
    sel.onPatternHoverSelection({ row: 3, trackIndex: 1 });
    sel.isMouseSelecting.value = false;
    clear = vi.fn(() => sel.clearSelection());
    container.addEventListener(
      'pointerdown',
      createClearSelectionOnPress(
        clear,
        () => sel.selectionAnchor.value !== null,
        { isExempt: (t) => t.closest('.sequence-item') !== null }
      )
    );
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('starts with a real selection', () => {
    expect(sel.selectionRect.value).toEqual({
      rowStart: 1,
      rowEnd: 3,
      trackStart: 0,
      trackEnd: 1,
    });
  });

  it.each([
    ['blank toolbar space', 'toolbar-gap'],
    ['panel padding', 'panel-gap'],
    ['track header gutter', 'header-gap'],
    ['the wrapper around the grid', 'wrapper-gap'],
    ['the waveform strip', 'waveform'],
    
  ])('clears on a press on %s', (_name, id) => {
    press($(id));
    expect(clear).toHaveBeenCalledTimes(1);
    expect(sel.selectionRect.value).toBeNull();
  });

  it('clears the container itself', () => {
    press(container);
    expect(sel.selectionRect.value).toBeNull();
  });

  it.each([
    ['a button', 'play-btn'],
    ['an input', 'bpm'],
    ['a label', 'lbl'],
    ['a Quasar field (and what is inside it)', 'q-select-text'],
    ['a mute button', 'mute-btn'],
    ['a sequence row (a clickable div)', 'seq-name'],
  ])('leaves the selection alone on a press on %s', (_name, id) => {
    press($(id));
    expect(clear).not.toHaveBeenCalled();
    expect(sel.selectionRect.value).not.toBeNull();
  });

  it('leaves the selection to the pattern grid: canvas, area and scroll proxy', () => {
    press($('pattern-canvas'));
    press($('pattern-area'));
    press($('scrollbar'));
    expect(clear).not.toHaveBeenCalled();
    expect(sel.selectionRect.value).not.toBeNull();
  });

  it('does not clear on a right-click (the bug-report menu needs the selection)', () => {
    press($('toolbar-gap'), { button: 2 });
    expect(sel.selectionRect.value).not.toBeNull();
  });

  it.each(['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const)(
    'does not clear a modified press (%s), which is the multi-select gesture',
    (mod) => {
      press($('toolbar-gap'), { [mod]: true });
      expect(sel.selectionRect.value).not.toBeNull();
    }
  );

  it('does nothing, and does not touch state, when nothing is selected', () => {
    sel.clearSelection();
    clear.mockClear();
    press($('toolbar-gap'));
    expect(clear).not.toHaveBeenCalled();
  });

  it('clears exactly once per press, however deep the target', () => {
    press($('toolbar-gap'));
    press($('toolbar-gap'));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe('a canvas drag-select is not disturbed by the clear', () => {
  beforeEach(() => {
    document.body.innerHTML = PAGE_HTML;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('press on the grid, drag, release: the drag selection survives and the clear never fires', () => {
    const container = document.getElementById('container') as HTMLElement;
    const canvas = document.getElementById('pattern-canvas') as HTMLElement;
    const sel = makeSelection();
    const clear = vi.fn(() => sel.clearSelection());
    container.addEventListener(
      'pointerdown',
      createClearSelectionOnPress(clear, () => sel.selectionAnchor.value !== null)
    );
    // The canvas' own mousedown is what starts the drag, and it follows pointerdown.
    canvas.addEventListener('mousedown', () =>
      sel.onPatternStartSelection({ row: 2, trackIndex: 0 })
    );

    // First a stale selection exists, then a fresh drag begins on the grid.
    sel.onPatternStartSelection({ row: 0, trackIndex: 0 });
    press(canvas);
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    sel.onPatternHoverSelection({ row: 5, trackIndex: 1 });
    sel.isMouseSelecting.value = false;

    expect(clear).not.toHaveBeenCalled();
    expect(sel.selectionRect.value).toEqual({
      rowStart: 2,
      rowEnd: 5,
      trackStart: 0,
      trackEnd: 1,
    });
  });

  it('a new selection made after a clear works as before', () => {
    const sel = makeSelection();
    sel.onPatternStartSelection({ row: 0, trackIndex: 0 });
    sel.clearSelection();
    sel.onPatternStartSelection({ row: 4, trackIndex: 1 });
    sel.onPatternHoverSelection({ row: 6, trackIndex: 1 });
    expect(sel.selectionRect.value).toEqual({
      rowStart: 4,
      rowEnd: 6,
      trackStart: 1,
      trackEnd: 1,
    });
  });
});

describe('shouldClearSelectionOnPress', () => {
  it('ignores a target that is not an element', () => {
    expect(
      shouldClearSelectionOnPress({
        button: 0,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: null,
      })
    ).toBe(false);
  });
});

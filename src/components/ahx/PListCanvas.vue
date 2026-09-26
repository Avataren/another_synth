<template>
  <div
    ref="rootRef"
    class="plist-canvas"
    role="group"
    aria-label="PList steps"
    v-bind="hasCanvas ? { tabindex: 0 } : {}"
    data-testid="ahx-plist-canvas"
    :data-rows="rowCount"
    :data-playhead-row="playbackRow"
    :data-playing="playbackRow >= 0 ? 'true' : 'false'"
    :data-selected-row="selectedRowValue"
    :data-edit="editMode ? 'true' : 'false'"
    :data-cursor-row="editMode ? selectedRowValue : -1"
    :data-cursor-column="editMode ? stop.column : -1"
    :data-cursor-nibble="editMode ? stop.nibble : -1"
    @keydown="onKeydown"
  >
    <p v-if="rowCount === 0" class="plist-canvas__note" data-testid="ahx-plist-canvas-empty">
      No steps yet, so there is nothing to draw.
    </p>
    <p v-else-if="failed" class="plist-canvas__note" data-testid="ahx-plist-canvas-error">
      The canvas could not start here; the steps are listed below.
    </p>
    <template v-else>
      <div class="plist-canvas__panel" :style="{ width: `${panelWidth}px` }">
        <div
          class="plist-canvas__stage"
          :style="{ height: `${stageHeight}px` }"
          @dblclick="onDoubleClick"
          @contextmenu="onContextMenu"
        >
          <!--
            The legend takes the place of the canvas's own header chip ("1 PList", hidden below): it sits in that
            band, over the columns it names. DOM, so it is selectable and testable.
          -->
          <div class="plist-canvas__legend" data-testid="ahx-plist-canvas-legend">
            <span
              v-for="cell in legend"
              :key="cell.key"
              class="plist-canvas__legend-cell"
              :style="{ left: `${cell.x}px`, width: `${cell.width - LEGEND_CELL_GAP_PX}px` }"
              :title="cell.title"
              :data-testid="`ahx-plist-canvas-legend-${cell.key}`"
              >{{ cell.label }}</span
            >
          </div>
          <PatternCanvas
            :tracks="tracks"
            :rows="rowCount"
            :selected-row="selectedRowValue"
            :playback-row="playbackRow"
            :active-track="editMode ? 0 : -1"
            :active-column="editMode ? stop.column : -1"
            :active-macro-nibble="editMode ? stop.nibble : 0"
            :selection-rect="selectionRect"
            :auto-scroll="true"
            :is-playing="playbackRow >= 0"
            playback-mode="pattern"
            :show-trail="false"
            :scroll-top="scrollTop"
            :container-width="containerWidth"
            :container-height="stageHeight - STAGE_CHROME_PX"
            :is-mouse-selecting="false"
            :show-extra-effect-column="true"
            :reserve-side-gutter="false"
            @row-selected="onRowSelected"
            @cell-selected="onCellSelected"
            @scroll="onCanvasScroll"
            @renderer-error="failed = true"
          />
        </div>
      </div>
      <p v-if="editMode" class="plist-canvas__note plist-canvas__note--edit" data-testid="ahx-plist-edit-hint">
        Typed keys edit the step under the cursor: hex digits, + and −, Delete to clear, F to fix a note (then a
        piano key types its pitch), Insert to add a row above, Ctrl+Delete to remove the row. Keyboard piano keys
        are off; the on-screen keys and MIDI still play. Ctrl+Z undoes (the song reloads, which stops a sounding note). Esc leaves.
      </p>
      <p class="plist-canvas__note" data-testid="ahx-plist-canvas-caption">
        One row per step, numbered in hex like the table below. Click a row to select it; with the
        canvas focused, the arrow keys, Home, End and Page Up / Down move the selection. Double-click a cell to
        edit it in the table below.<span v-if="editable" data-testid="ahx-plist-canvas-caption-menu">
          Right-click a row for the row menu.</span
        >
        <span v-if="audible" data-testid="ahx-plist-canvas-caption-playhead">
          Play a key to hear this instrument: the bar shows the step its note is on. A step shorter than a
          screen frame is passed over, not drawn.
        </span>
      </p>
      <PListCanvasMenu
        :open="menu.open"
        :x="menu.x"
        :y="menu.y"
        :row="menu.row"
        :reasons="menu.reasons"
        @pick="onMenuPick"
        @close="closeMenu"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
/**
 * The PList drawn in the tracker's own canvas grammar (plan
 * `.ai/plan-plist-canvas.md`, batch B3: static). One `PatternCanvas`, one track,
 * one row per PList step, projected by `plist-track.ts`; the legend row over it
 * names the columns (`plist-legend.ts`). The table below stays the exact-entry
 * editor, and the selection is shared with it.
 *
 * Nothing here writes: the canvas selects and navigates. `playheadRow` (B4) is
 * the engine's own row for the sounding preview note, already matched to this
 * instrument by the page; it drives `PatternCanvas`'s playing-row pill, with the
 * trail off: in a PList the rows above the playing one are not necessarily the
 * rows just played.
 *
 * `instrument` is reactive store state, replaced wholesale on every edit; the
 * projection reads it through `toRaw` and is memoised on content, so an edit
 * that leaves the PList alone (an envelope drag) does not repaint the canvas.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { AhxInstrument } from '@another-synth/tracker-playback';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import PListCanvasMenu from './PListCanvasMenu.vue';
import {
  GUTTER_WIDTH_PX,
  patternPanelWidth,
  rowHeightPx,
  rowPitchPx,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import { isTextEntryTarget } from 'src/composables/keyboard/note-key-map';
import { AHX_DEFAULT_OCTAVE } from 'src/composables/useAhxPlayInput';
import {
  PLIST_PAGE_ROWS,
  plistKeyAction,
  snapToStop,
  type PListColumn,
  type PListCursor,
  type PListIntent,
  type PListMenuAction,
} from 'src/audio/tracker/plist-edit-input';
import type { PListNibble } from 'src/audio/tracker/plist-edit';
import type { TrackerSelectionRect } from 'src/components/tracker/tracker-types';
import { createPListTrackMemo, rawPListEntries } from 'src/audio/tracker/plist-track';
import { plistLegendCells, PLIST_TRACK_WIDTH_PX } from './plist-legend';
import { trackColumns } from 'src/components/tracker/track-metrics';

interface Props {
  instrument: AhxInstrument | null;
  /** The selected step, or `null` for none (shared with the table and the chip strip). */
  selected: number | null;
  /** The step the engine's preview note is on, or -1 for none (the page has already matched the instrument). */
  playheadRow?: number;
  /**
   * Whether a note can sound here at all (the song's bytes are there to play from). The line about the bar is
   * only said then: with nothing to hear there is no bar to explain.
   */
  audible?: boolean;
  /** The song can be edited from here (an editable AHX song: its edits have an undo): the row menu is offered. */
  editable?: boolean;
  /** Edit mode: the cursor cell is drawn and the keyboard types into it (the page owns the mode). */
  editMode?: boolean;
  /** Where the cursor stands in its row; the row is `selected`. */
  cursor?: { column: PListColumn; nibble: PListNibble };
  /** The tracker's edit step, and the page's octave: what a finished entry advances by, and what a piano key enters. */
  stepSize?: number;
  octave?: number;
  /** Why a menu action cannot be done on `row` right now (the 255-row cap, the file's size); an action not listed can. */
  menuReasons?: (row: number) => Partial<Record<PListMenuAction, string>>;
}

const props = withDefaults(defineProps<Props>(), {
  playheadRow: -1,
  audible: false,
  editable: false,
  editMode: false,
  cursor: () => ({ column: 0, nibble: 0 }),
  stepSize: 1,
  octave: AHX_DEFAULT_OCTAVE,
  menuReasons: () => ({}),
});
const emit = defineEmits<{
  (event: 'select', row: number): void;
  /** Edit mode: the cursor moves (a key or a click); the page sets the row and the stop. */
  (event: 'cursor', cursor: PListCursor): void;
  /** A key or a menu pick asks for an edit; `cursorAfter` is where the cursor goes if it worked. */
  (event: 'edit', request: { intent: PListIntent; cursorAfter: PListCursor | null; continues: boolean }): void;
  /** A key the canvas took cannot be done. */
  (event: 'refuse', reason: string): void;
  (event: 'undo'): void;
  (event: 'redo'): void;
  /** Double-click: the table field for the cell. */
  (event: 'focus-field', testid: string): void;
}>();

/** Rows the card shows before the canvas scrolls. */
const VIEW_ROWS = PLIST_PAGE_ROWS;
/** Air between two legend labels: a label narrower than its column, so "Command 1" wraps rather than touching the next one. */
const LEGEND_CELL_GAP_PX = 8;
/** The panel's own chrome around the scroller: padding 14 + 12, border 2, gap 8, header strip 46. */
const STAGE_CHROME_PX = 14 + 12 + 2 + 8 + 46;

/** Where the cursor stands in its row (its row is the selected one). */
const stop = computed(() => props.cursor ?? { column: 0 as PListColumn, nibble: 0 as PListNibble });

const rootRef = ref<HTMLElement | null>(null);
const failed = ref(false);
const scrollTop = ref(0);

const rowCount = computed(() => rawPListEntries(props.instrument).length);
const hasCanvas = computed(() => rowCount.value > 0 && !failed.value);

// The track keeps its identity while the PList's content does (the memo), and
// so does the one-element array PatternCanvas watches by reference.
const project = createPListTrackMemo();
let lastTrack: ReturnType<typeof project> | null = null;
let lastTracks: ReturnType<typeof project>[] = [];
const tracks = computed(() => {
  const track = project(props.instrument);
  if (track !== lastTrack) {
    lastTrack = track;
    lastTracks = [track];
  }
  return lastTracks;
});

const selectedRowValue = computed(() =>
  props.selected !== null && props.selected >= 0 && props.selected < rowCount.value ? props.selected : -1,
);

/** The selected step's highlight: the canvas's selection bar, over the one track. */
const selectionRect = computed<TrackerSelectionRect | null>(() =>
  selectedRowValue.value < 0
    ? null
    : { rowStart: selectedRowValue.value, rowEnd: selectedRowValue.value, trackStart: 0, trackEnd: 0 },
);

/** No bar for a row the list no longer has (the list was shortened under a sounding note). */
const playbackRow = computed(() =>
  props.playheadRow >= 0 && props.playheadRow < rowCount.value ? props.playheadRow : -1,
);

const legend = computed(() => plistLegendCells(PLIST_TRACK_WIDTH_PX));
const panelWidth = patternPanelWidth(GUTTER_WIDTH_PX + totalTracksWidth(1, trackColumns(true, true)));
const stageHeight = computed(() => STAGE_CHROME_PX + Math.min(rowCount.value, VIEW_ROWS) * rowPitchPx);

// PatternCanvas caps its panel by `containerWidth - 36` and shows a
// horizontal scrollbar when the panel is wider; the measured width of this
// host is what is available (seeded with the natural width, so an unmeasured
// host, before layout or in a test, shows none).
const PAGE_PADDING_X_PX = 36;
const containerWidth = ref(panelWidth + PAGE_PADDING_X_PX);
let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  const el = rootRef.value;
  if (!el || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    const width = el.clientWidth;
    if (width > 0) containerWidth.value = width + PAGE_PADDING_X_PX;
  });
  resizeObserver.observe(el);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

function onCanvasScroll(payload: { top: number; left: number }): void {
  scrollTop.value = payload.top;
}

/** A click or tap on a row or cell: select the step and take focus, so the arrow keys work at once. */
function onPointerSelect(row: number): void {
  if (row < 0 || row >= rowCount.value) return;
  emit('select', row);
  rootRef.value?.focus({ preventScroll: true });
}

/** The last cell a click landed on: a double-click is that cell's hand-off to the table. */
let lastCell: { row: number; column: number; nibble: number } | null = null;

function onCellSelected(payload: { row: number; column: number; macroNibble?: number }): void {
  const snapped = snapToStop(payload.column, payload.macroNibble);
  lastCell = { row: payload.row, column: snapped.column, nibble: snapped.nibble };
  onPointerSelect(payload.row);
  if (props.editMode && payload.row >= 0 && payload.row < rowCount.value) emit('cursor', { row: payload.row, ...snapped });
}

function onRowSelected(row: number): void {
  lastCell = null;
  onPointerSelect(row);
}

/** The table field a cell hands off to: a command's digit is its command select, its two parameter digits its number field. */
function fieldTestid(cell: { row: number; column: number; nibble: number }): string {
  const base = `ahx-plist-${cell.row}`;
  if (cell.column === 0) return `${base}-note`;
  if (cell.column === 1) return `${base}-waveform`;
  const slot = cell.column === 5 ? 1 : 0;
  return cell.nibble === 0 ? `${base}-fx${slot}` : `${base}-param${slot}`;
}

function onDoubleClick(): void {
  if (lastCell === null || lastCell.row >= rowCount.value) return;
  emit('focus-field', fieldTestid(lastCell));
}

// --- the row menu ----------------------------------------------------------

const menu = reactive<{ open: boolean; x: number; y: number; row: number; reasons: Partial<Record<PListMenuAction, string>> }>({
  open: false,
  x: 0,
  y: 0,
  row: 0,
  reasons: {},
});

/** The row under a pointer event: the canvas's own arithmetic (the scroll offset plus the y in its viewport, a row's gap is no row). */
function rowAtEvent(event: MouseEvent): number | null {
  const canvas = event.target instanceof Element ? event.target.closest('canvas') : null;
  if (!canvas) return null;
  const localY = event.clientY - canvas.getBoundingClientRect().top + scrollTop.value;
  if (localY < 0 || localY % rowPitchPx >= rowHeightPx) return null;
  const row = Math.floor(localY / rowPitchPx);
  return row < rowCount.value ? row : null;
}

function onContextMenu(event: MouseEvent): void {
  if (!props.editable) return;
  const row = rowAtEvent(event);
  if (row === null) return;
  event.preventDefault();
  emit('select', row);
  menu.row = row;
  menu.x = event.clientX;
  menu.y = event.clientY;
  menu.reasons = props.menuReasons(row);
  menu.open = true;
}

/** Escape gives the keyboard back to the canvas; a click elsewhere takes it wherever the click went. */
function closeMenu(how: 'escape' | 'outside'): void {
  menu.open = false;
  if (how === 'escape') focus();
}

function onMenuPick(action: PListMenuAction): void {
  menu.open = false;
  focus();
  const row = menu.row;
  const at = stop.value;
  const after = (nextRow: number): PListCursor => ({ row: Math.max(0, nextRow), column: at.column, nibble: at.nibble });
  const count = rowCount.value;
  switch (action) {
    case 'insert-above':
      return emit('edit', { intent: { kind: 'insert-above', row }, cursorAfter: after(row), continues: false });
    case 'insert-below':
      return emit('edit', { intent: { kind: 'insert-below', row }, cursorAfter: after(row + 1), continues: false });
    case 'duplicate':
      return emit('edit', { intent: { kind: 'duplicate', row }, cursorAfter: after(row + 1), continues: false });
    case 'delete':
      return emit('edit', { intent: { kind: 'delete', row }, cursorAfter: after(Math.min(row, count - 2)), continues: false });
    case 'clear':
      return emit('edit', { intent: { kind: 'clear', row }, cursorAfter: after(row), continues: false });
    case 'fixed':
      return emit('edit', { intent: { kind: 'fixed', row }, cursorAfter: after(row), continues: false });
  }
}

// The menu is about a row that may be gone or another instrument's by the next repaint.
watch([rowCount, () => props.editable], () => {
  menu.open = false;
});

/** Give the canvas the keyboard (entering Edit mode does). */
function focus(): void {
  void nextTick(() => rootRef.value?.focus({ preventScroll: true }));
}
defineExpose({ focus });

// --- the keyboard ------------------------------------------------------------

/**
 * View mode: arrow keys, Home, End and Page Up / Down move the selection. Only
 * these keys are taken, and only when no modifier is held: every other key
 * passes through (the audition keys, Escape, and Shift+Page Up / Down, the
 * octave shortcut).
 *
 * Edit mode: the key table (`plist-edit-input.ts`); a key it does not know
 * passes through as well. Keys typed into a text field, or into the row menu, are
 * not the canvas's.
 */
function onKeydown(event: KeyboardEvent): void {
  const count = rowCount.value;
  if (count === 0) return;
  // The row menu sits inside this element: its keys are its own.
  if (event.target instanceof Element && event.target.closest('[data-testid="ahx-plist-canvas-menu"]')) return;
  if (props.editMode) {
    onEditKeydown(event);
    return;
  }
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const current = selectedRowValue.value;
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = current < 0 ? 0 : Math.min(count - 1, current + 1);
      break;
    case 'ArrowUp':
      next = current < 0 ? count - 1 : Math.max(0, current - 1);
      break;
    case 'PageDown':
      next = current < 0 ? Math.min(count - 1, VIEW_ROWS - 1) : Math.min(count - 1, current + VIEW_ROWS);
      break;
    case 'PageUp':
      next = current < 0 ? count - 1 : Math.max(0, current - VIEW_ROWS);
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = count - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  event.stopPropagation();
  emit('select', next);
}

function onEditKeydown(event: KeyboardEvent): void {
  if (isTextEntryTarget(event.target)) return;
  const row = selectedRowValue.value < 0 ? 0 : selectedRowValue.value;
  const entry = rawPListEntries(props.instrument)[row];
  const action = plistKeyAction(
    event,
    { row, column: stop.value.column, nibble: stop.value.nibble },
    { rowCount: rowCount.value, rowFixed: entry?.fixed === true, stepSize: props.stepSize, octave: props.octave },
  );
  if (action.type === 'pass') return;
  event.preventDefault();
  event.stopPropagation();
  switch (action.type) {
    case 'move':
      emit('cursor', action.cursor);
      break;
    case 'edit':
      emit('edit', { intent: action.intent, cursorAfter: action.cursorAfter, continues: action.continues });
      break;
    case 'refuse':
      emit('refuse', action.reason);
      break;
    case 'undo':
      emit('undo');
      break;
    case 'redo':
      emit('redo');
      break;
  }
}
</script>

<style scoped>
.plist-canvas {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
  outline: none;
}

.plist-canvas:focus-visible .plist-canvas__stage {
  outline: 2px solid var(--tracker-accent-primary, #f0b25e);
  outline-offset: 2px;
  border-radius: 16px;
}

.plist-canvas__panel {
  max-width: 100%;
  margin-inline: auto;
}

.plist-canvas__stage {
  position: relative;
  /* The canvas panel's own chrome: 18px side padding + 1px border, 14px top padding; its header band is 46px tall. */
  --plist-panel-inset: 19px;
  --plist-legend-top: 25px;
}

/* The header chip ("1 PList") says nothing a PList needs; the legend takes its place. */
.plist-canvas__stage :deep(.header-track) {
  visibility: hidden;
}

.plist-canvas__legend {
  position: absolute;
  z-index: 2;
  top: var(--plist-legend-top);
  left: var(--plist-panel-inset);
  right: var(--plist-panel-inset);
  height: 24px;
  /* Small on purpose: "Command" has to fit a command column (52px), and wrap before its number. */
  font-size: 9px;
  font-weight: 700;
  line-height: 1.1;
  color: var(--text-muted, #a7bcd8);
  pointer-events: none;
}

.plist-canvas__legend-cell {
  position: absolute;
  top: 2px;
  cursor: help;
  pointer-events: auto;
}

.plist-canvas__note {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}

.plist-canvas__note--edit {
  opacity: 1;
  color: var(--tracker-accent-primary, #f0b25e);
}

/* Matches PatternCanvas's phone layout, which shrinks the panel's chrome to 6px padding + 1px border. */
@media (max-width: 900px), (pointer: coarse) and (max-width: 1180px) {
  .plist-canvas__stage {
    --plist-panel-inset: 7px;
    --plist-legend-top: 11px;
  }
}
</style>

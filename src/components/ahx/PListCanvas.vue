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
        <div class="plist-canvas__stage" :style="{ height: `${stageHeight}px` }">
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
            :active-track="-1"
            :active-column="-1"
            :active-macro-nibble="0"
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
            @row-selected="onPointerSelect"
            @cell-selected="onPointerSelect($event.row)"
            @scroll="onCanvasScroll"
            @renderer-error="failed = true"
          />
        </div>
      </div>
      <p class="plist-canvas__note" data-testid="ahx-plist-canvas-caption">
        One row per step, numbered in hex like the table below. Click a row to select it; with the
        canvas focused, the arrow keys, Home, End and Page Up / Down move the selection.
      </p>
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
 * Nothing here writes: the canvas selects and navigates. The playhead is the
 * next batch; `playheadRow` is its seam (it drives `PatternCanvas`'s own
 * playing-row pill, with the trail off: in a PList the rows above the playing
 * one are not necessarily the rows just played).
 *
 * `instrument` is reactive store state, replaced wholesale on every edit; the
 * projection reads it through `toRaw` and is memoised on content, so an edit
 * that leaves the PList alone (an envelope drag) does not repaint the canvas.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AhxInstrument } from '@another-synth/tracker-playback';
import PatternCanvas from 'src/components/tracker/pattern-canvas/PatternCanvas.vue';
import {
  GUTTER_WIDTH_PX,
  patternPanelWidth,
  rowPitchPx,
  totalTracksWidth,
} from 'src/components/tracker/pattern-canvas/pattern-layout';
import type { TrackerSelectionRect } from 'src/components/tracker/tracker-types';
import { createPListTrackMemo, rawPListEntries } from 'src/audio/tracker/plist-track';
import { plistLegendCells, PLIST_TRACK_WIDTH_PX } from './plist-legend';

interface Props {
  instrument: AhxInstrument | null;
  /** The selected step, or `null` for none (shared with the table and the chip strip). */
  selected: number | null;
  /** The step the engine is on, or -1 for none. The playhead batch feeds this; it defaults to none. */
  playheadRow?: number;
}

const props = withDefaults(defineProps<Props>(), { playheadRow: -1 });
const emit = defineEmits<{ (event: 'select', row: number): void }>();

/** Rows the card shows before the canvas scrolls. */
const VIEW_ROWS = 8;
/** Air between two legend labels: a label narrower than its column, so "Command 1" wraps rather than touching the next one. */
const LEGEND_CELL_GAP_PX = 8;
/** The panel's own chrome around the scroller: padding 14 + 12, border 2, gap 8, header strip 46. */
const STAGE_CHROME_PX = 14 + 12 + 2 + 8 + 46;

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
const panelWidth = patternPanelWidth(GUTTER_WIDTH_PX + totalTracksWidth(1, true));
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

/**
 * Arrow keys, Home, End and Page Up / Down move the selection. Only these keys
 * are taken, and only when no modifier is held: every other key passes through
 * (the audition keys, Escape, and Shift+Page Up / Down, the octave shortcut).
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
  const count = rowCount.value;
  if (count === 0) return;
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

/* Matches PatternCanvas's phone layout, which shrinks the panel's chrome to 6px padding + 1px border. */
@media (max-width: 900px), (pointer: coarse) and (max-width: 1180px) {
  .plist-canvas__stage {
    --plist-panel-inset: 7px;
    --plist-legend-top: 11px;
  }
}
</style>

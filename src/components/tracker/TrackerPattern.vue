<template>
  <div
    class="tracker-pattern"
    :class="{ 'playback-pattern': isPlaying && playbackMode === 'pattern', 'playback-song': isPlaying && playbackMode === 'song' }"
    :style="{
      '--tracker-row-height': rowHeight,
      '--tracker-header-height': headerHeight,
      '--tracker-accent': accentColor,
      '--tracker-side-gutter': sideGutter
    }"
  >
    <div class="pattern-body">
      <template v-if="!isPlaying">
        <!--
          Idle/edit mode: single buffer, exactly as before. Rendering the
          double-buffer machinery only during playback keeps idle editing
          free of the extra grid instance and any flip churn.
        -->
        <div class="row-column">
          <div class="row-header">Row</div>
          <div class="row-numbers-container" :style="{ height: `${totalRowsHeight}px` }">
            <div class="row-numbers-viewport" :style="rowsOffsetStyle">
              <button
                v-for="row in visibleRowsList"
                :key="row"
                type="button"
                class="row-number"
                tabindex="-1"
                :class="{
                  selected: effectiveSelectedRow === row,
                  'in-selection': isRowInSelection(row)
                }"
                @click="selectRow(row)"
              >
                {{ formatRow(row) }}
              </button>
            </div>
            <div class="row-playback-bar" :style="rowBarStyle"></div>
          </div>
        </div>

        <div class="tracks-wrapper" ref="tracksWrapperRef" :style="trackWrapperStyle">
          <div class="active-row-bar" :style="activeBarStyle"></div>
          <TrackerTrack
            v-for="(track, index) in tracks"
            :key="track.id"
            :track="track"
            :row-count="rows"
            :selected-row="effectiveSelectedRow"
            :index="index"
            :active-track="activeTrack"
            :active-column="activeColumn"
            :active-macro-nibble="activeMacroNibble"
            :selection-rect="selectionRect"
            :visible-start-row="visibleRange.startRow"
            :visible-end-row="visibleRange.endRow"
            :show-extra-effect-column="showExtraEffectColumn"
            @rowSelected="selectRow"
            @cellSelected="selectCell"
            @startSelection="startSelection"
            @hoverSelection="hoverSelection"
          />
        </div>
      </template>

      <template v-else>
        <!--
          Playback: two persistent buffers stacked over each other. The
          visible one shows the current pattern; the hidden one pre-renders
          the upcoming pattern (visibility:hidden, not display:none, so its
          layout and raster stay warm). On a pattern change the flip is one
          reactive variable -- the hidden buffer becomes visible in the same
          tick, so no blank state ever exists between the two.
        -->
        <div
          v-for="slotKey in bufferSlots"
          :key="slotKey"
          class="pattern-buffer"
          :class="{ 'buffer-hidden': !isSlotVisible(slotKey) }"
          :aria-hidden="!isSlotVisible(slotKey)"
        >
          <div class="row-column">
            <div class="row-header">Row</div>
            <div class="row-numbers-container" :style="{ height: `${bufferRowsHeight(slotKey)}px` }">
              <div class="row-numbers-viewport" :style="bufferRowsOffsetStyle(slotKey)">
                <button
                  v-for="row in bufferVisibleRows(slotKey)"
                  :key="row"
                  type="button"
                  class="row-number"
                  tabindex="-1"
                  @click="onBufferRowClick(slotKey, row)"
                >
                  {{ formatRow(row) }}
                </button>
              </div>
              <div class="row-playback-bar" :style="bufferRowBarStyle(slotKey)"></div>
            </div>
          </div>

          <div
            class="tracks-wrapper"
            :ref="(el) => setTracksWrapperRef(slotKey, el)"
            :style="trackWrapperStyle"
          >
            <div class="active-row-bar" :style="bufferActiveBarStyle(slotKey)"></div>
            <TrackerTrack
              v-for="(track, index) in bufferTracks(slotKey)"
              :key="track.id"
              :track="track"
              :row-count="bufferRows(slotKey)"
              :selected-row="bufferSelectedRow(slotKey)"
              :index="index"
              :active-track="bufferActiveTrack(slotKey)"
              :active-column="bufferActiveColumn(slotKey)"
              :active-macro-nibble="activeMacroNibble"
              :selection-rect="bufferSelectionRect(slotKey)"
              :visible-start-row="bufferVisibleRange(slotKey).startRow"
              :visible-end-row="bufferVisibleRange(slotKey).endRow"
              :show-extra-effect-column="showExtraEffectColumn"
            />
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import TrackerTrack from './TrackerTrack.vue';
import type { TrackerSelectionRect, TrackerTrackData } from './tracker-types';
import { trackGapPx, trackWidthPx } from './track-metrics';
import { activeRowBarWidthPx } from './pattern-buffering';

/** One ping-pong buffer slot: the rendered grid for one pattern. */
interface PatternBuffer {
  patternId: string | null;
  tracks: TrackerTrackData[];
  rows: number;
}

type BufferSlot = 'a' | 'b';

interface Props {
  tracks: TrackerTrackData[];
  rows: number;
  selectedRow: number;
  playbackRow: number;
  activeTrack: number;
  activeColumn: number;
  autoScroll: boolean;
  isPlaying: boolean;
  playbackMode: 'pattern' | 'song';
  activeMacroNibble: number;
  selectionRect: TrackerSelectionRect | null;
  scrollTop: number;
  containerHeight: number;
  isMouseSelecting: boolean;
  showExtraEffectColumn: boolean;
  /** Whether the spectrum analyser is on and needs gutters to draw in. */
  reserveSideGutter: boolean;
  /** Pattern coming next in the sequence, or null when unknown/not playing. */
  upcomingPattern?: { id: string; tracks: TrackerTrackData[]; rows: number } | null;
}

const props = withDefaults(defineProps<Props>(), {
  upcomingPattern: null
});

const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number; macroNibble?: number }): void;
  (event: 'startSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'hoverSelection', payload: { row: number; trackIndex: number }): void;
}>();

const rowHeightPx = 30;
const rowGapPx = 6;
const headerHeightPx = 46;
const rowHeight = `${rowHeightPx}px`;
const headerHeight = `${headerHeightPx}px`;
// Shared with the waveform row above the pattern, which has to line up with
// these exactly -- see track-metrics.ts.
const trackWidth = computed(
  () => `${trackWidthPx(props.tracks.length, props.showExtraEffectColumn)}px`,
);
const trackGap = computed(() => `${trackGapPx(props.tracks.length)}px`);

/**
 * Width held back on each side of the pattern for the spectrum analyser.
 *
 * The analyser draws into the empty gutters beside this panel, measuring them
 * from the panel's own box. But the panel is a block-level flex container, so
 * it takes the full width whatever the channel count, and the gutters
 * collapsed to the few pixels of page padding -- there was nowhere for the
 * analyser to draw.
 *
 * One track column is the reserve: enough to read, and expressed in the same
 * unit as the thing it sits beside, so it stays proportionate as the columns
 * tighten. The stylesheet caps it as a share of the width too, so a narrow
 * window spends most of its space on the pattern rather than the gutters.
 */
const sideGutter = computed(() =>
  props.reserveSideGutter
    ? `${trackWidthPx(props.tracks.length, props.showExtraEffectColumn)}px`
    : '0px',
);

const trackWrapperStyle = computed(() => ({
  '--tracker-track-width': trackWidth.value,
  '--tracker-track-gap': trackGap.value
}));
const accentColor = '#4df2c5';
const tracksWrapperRef = ref<HTMLElement | null>(null);
const selectionRect = computed(() => props.selectionRect);

const bufferSlots = ['a', 'b'] as const;
const activeSlot = ref<BufferSlot>('a');
const buffers = ref<Record<BufferSlot, PatternBuffer>>({
  a: { patternId: null, tracks: [], rows: 0 },
  b: { patternId: null, tracks: [], rows: 0 }
});

const bufferTracksWrapperRefs: Record<BufferSlot, HTMLElement | null> = {
  a: null,
  b: null
};

function setTracksWrapperRef(slot: BufferSlot, el: unknown) {
  bufferTracksWrapperRefs[slot] = (el as HTMLElement) ?? null;
  if (slot === activeSlot.value) tracksWrapperRef.value = bufferTracksWrapperRefs[slot];
}

/** The tracks a slot renders: its buffer content while playing. */
function bufferTracks(slot: BufferSlot): TrackerTrackData[] {
  return buffers.value[slot].tracks;
}
function bufferRows(slot: BufferSlot): number {
  return buffers.value[slot].rows;
}

function isSlotVisible(slot: BufferSlot): boolean {
  return slot === activeSlot.value;
}

// Virtual scrolling - use scroll info from parent
const overscan = 5; // Extra rows to render above/below viewport

function computeVisibleRange(rows: number) {
  const rowTotalHeight = rowHeightPx + rowGapPx;
  // Account for header height and padding in scroll offset calculation
  const adjustedScrollTop = Math.max(0, props.scrollTop - headerHeightPx - 18); // 18px is pattern padding
  const startRow = Math.max(0, Math.floor(adjustedScrollTop / rowTotalHeight) - overscan);
  const visibleRows = Math.ceil(props.containerHeight / rowTotalHeight) + overscan * 2;
  const endRow = Math.min(rows - 1, startRow + visibleRows);
  return { startRow, endRow };
}

const visibleRange = computed(() => computeVisibleRange(props.rows));

// Only the visible rows for the row column (idle single-buffer mode)
const visibleRowsList = computed(() => {
  const { startRow, endRow } = visibleRange.value;
  return Array.from({ length: endRow - startRow + 1 }, (_, idx) => startRow + idx);
});

// Total height of all rows for the virtual scroll container
const totalRowsHeight = computed(() => props.rows * (rowHeightPx + rowGapPx));

// Offset for positioning visible rows
const rowsOffsetStyle = computed(() => ({
  transform: `translateY(${visibleRange.value.startRow * (rowHeightPx + rowGapPx)}px)`
}));

function bufferVisibleRange(slot: BufferSlot) {
  return computeVisibleRange(bufferRows(slot));
}
function bufferVisibleRows(slot: BufferSlot) {
  const { startRow, endRow } = bufferVisibleRange(slot);
  return Array.from({ length: Math.max(0, endRow - startRow + 1) }, (_, idx) => startRow + idx);
}
function bufferRowsHeight(slot: BufferSlot) {
  return bufferRows(slot) * (rowHeightPx + rowGapPx);
}
function bufferRowsOffsetStyle(slot: BufferSlot) {
  return {
    transform: `translateY(${bufferVisibleRange(slot).startRow * (rowHeightPx + rowGapPx)}px)`
  };
}

// During playback, don't propagate selectedRow changes to TrackerTrack/TrackerEntry
// The active-row-bar provides visual feedback instead, avoiding component re-renders
const effectiveSelectedRow = computed(() => props.isPlaying ? -1 : props.selectedRow);

// Hidden buffers get inert placeholders for the editing-highlight props so a
// pattern swap cannot flash selection state inside the still-hidden grid.
function bufferSelectedRow(slot: BufferSlot): number {
  return isSlotVisible(slot) ? effectiveSelectedRow.value : -1;
}
function bufferActiveTrack(slot: BufferSlot): number {
  return isSlotVisible(slot) ? props.activeTrack : -1;
}
function bufferActiveColumn(slot: BufferSlot): number {
  return isSlotVisible(slot) ? props.activeColumn : -1;
}
function bufferSelectionRect(slot: BufferSlot): TrackerSelectionRect | null {
  return isSlotVisible(slot) ? props.selectionRect : null;
}

// Scroll container ref (used for programmatic scrolling)
const patternAreaRef = ref<HTMLElement | null>(null);

/**
 * Bar width is pure math now (pattern-buffering.ts over track-metrics.ts):
 * the first column's width plus one pitch per additional column. The old
 * nextTick DOM measurement raced the pattern swap and reset the bar to 100%
 * for a frame; this computes reactively, including while a buffer is still
 * hidden.
 */
const activeBarWidth = computed(() =>
  activeRowBarWidthPx(props.tracks.length, props.showExtraEffectColumn),
);

const activeBarStyle = computed(() => {
  const offset = headerHeightPx + 6 + props.playbackRow * (rowHeightPx + rowGapPx);
  return {
    transform: `translateY(${offset}px)`,
    height: rowHeight,
    width: activeBarWidth.value ? `${activeBarWidth.value}px` : '100%'
  };
});

const rowBarStyle = computed(() => {
  const row = props.isPlaying ? props.playbackRow : props.selectedRow;
  const offset = row * (rowHeightPx + rowGapPx);
  return {
    transform: `translateY(${offset}px)`,
    height: rowHeight
  };
});

function bufferRowBarStyle(slot: BufferSlot) {
  const row = isSlotVisible(slot)
    ? (props.isPlaying ? props.playbackRow : props.selectedRow)
    : 0;
  const offset = row * (rowHeightPx + rowGapPx);
  return {
    transform: `translateY(${offset}px)`,
    height: rowHeight
  };
}

function bufferActiveBarStyle(slot: BufferSlot) {
  const offset = headerHeightPx + 6 + props.playbackRow * (rowHeightPx + rowGapPx);
  return {
    transform: `translateY(${offset}px)`,
    height: rowHeight,
    width: activeBarWidth.value ? `${activeBarWidth.value}px` : '100%'
  };
}

function onBufferRowClick(slot: BufferSlot, row: number) {
  // The hidden buffer is pointer-events:none anyway; this guards the visible
  // one only, so clicks can never select rows in the upcoming pattern.
  if (isSlotVisible(slot)) selectRow(row);
}

function formatRow(row: number) {
  return row.toString(16).toUpperCase().padStart(2, '0');
}

function selectRow(row: number) {
  emit('rowSelected', row);
}

function selectCell(payload: { row: number; column: number; trackIndex: number; macroNibble?: number }) {
  emit('cellSelected', payload);
}

function startSelection(payload: { row: number; trackIndex: number }) {
  emit('startSelection', payload);
}

function hoverSelection(payload: { row: number; trackIndex: number }) {
  emit('hoverSelection', payload);
}

function isRowInSelection(row: number) {
  if (!props.selectionRect) return false;
  return row >= props.selectionRect.rowStart && row <= props.selectionRect.rowEnd;
}

// Snap scroll to center a row
function scrollToRow(row: number) {
  const container = patternAreaRef.value;
  if (!container) {
    return;
  }

  // Row position within the pattern (after header)
  const rowTop = headerHeightPx + rowGapPx + row * (rowHeightPx + rowGapPx);
  const containerHeight = container.clientHeight;

  // Center the row - snap instantly
  container.scrollTop = Math.max(0, rowTop - containerHeight / 2 + rowHeightPx / 2);
}

// Consolidated scroll target - prioritizes playback row during playback, otherwise selected row
const scrollTarget = computed(() => {
  if (!props.autoScroll) return null;
  if (props.isPlaying) return props.playbackRow;
  // Avoid fighting with mouse selection; let user control scroll while selecting
  if (props.isMouseSelecting) return null;
  return props.selectedRow;
});

// Single watcher for both playback and selection scrolling
watch(scrollTarget, (row) => {
  if (row === null) return;
  scrollToRow(row);
});

function emptyBuffer(): PatternBuffer {
  return { patternId: null, tracks: [], rows: 0 };
}

/**
 * Playback ping-pong bookkeeping.
 *
 * On playback start: buffer A takes the current pattern and becomes visible.
 * While playing: the upcoming pattern is written into the hidden slot, and
 * when the parent's `tracks` prop swaps to that pattern (the moment the old
 * code blanked) the flip is a single assignment of `activeSlot` -- both
 * grids stay mounted, only visibility changes.
 */
watch(
  () => props.isPlaying,
  (playing) => {
    if (playing) {
      buffers.value = {
        a: { patternId: null, tracks: props.tracks, rows: props.rows },
        b: emptyBuffer()
      };
      activeSlot.value = 'a';
      tracksWrapperRef.value = bufferTracksWrapperRefs.a;
    } else {
      // Leaving playback: drop the buffers so idle mode renders fresh.
      buffers.value = { a: emptyBuffer(), b: emptyBuffer() };
      activeSlot.value = 'a';
      tracksWrapperRef.value = null;
    }
  },
  { immediate: true }
);

// Pre-render the upcoming pattern into the hidden buffer.
watch(
  () => props.upcomingPattern,
  (upcoming) => {
    if (!props.isPlaying || !upcoming) return;
    const hidden: BufferSlot = activeSlot.value === 'a' ? 'b' : 'a';
    const current = buffers.value[hidden];
    if (current.patternId === upcoming.id && current.tracks === upcoming.tracks) return;
    buffers.value[hidden] = { patternId: upcoming.id, tracks: upcoming.tracks, rows: upcoming.rows };
  }
);

// The parent swapped patterns (single watcher so flip-vs-sync ordering is
// deterministic): if the new pattern is the one sitting in the hidden
// buffer, flip atomically -- one `activeSlot` assignment, both grids stay
// mounted, only visibility changes. Otherwise the parent is showing a direct
// jump/edit: sync the active buffer in place (stable row keys patch cells
// instead of remounting).
watch(
  [() => props.tracks, () => props.rows],
  ([tracks, rows]) => {
    if (!props.isPlaying) return;
    const hidden: BufferSlot = activeSlot.value === 'a' ? 'b' : 'a';
    if (tracks.length > 0 && buffers.value[hidden].tracks === tracks) {
      activeSlot.value = hidden;
      tracksWrapperRef.value = bufferTracksWrapperRefs[hidden];
    } else {
      const slot = activeSlot.value;
      if (buffers.value[slot].tracks !== tracks || buffers.value[slot].rows !== rows) {
        buffers.value[slot] = { ...buffers.value[slot], tracks, rows };
      }
    }
  }
);

onMounted(() => {
  // Find the scroll container (.pattern-area is in the parent)
  const trackerPattern = (tracksWrapperRef.value ?? bufferTracksWrapperRefs[activeSlot.value])?.closest('.tracker-pattern');
  if (trackerPattern) {
    patternAreaRef.value = trackerPattern.closest('.pattern-area') as HTMLElement | null;
  }
});

defineExpose({
  tracksWrapperRef
});
</script>

<style scoped>
.tracker-pattern {
  display: flex;
  flex-direction: column;
  /* Leave the spectrum analyser a gutter to draw in on each side, and stay
     centred between them. Capped as a share of the available width as well,
     so on a narrow window the pattern keeps most of the space. */
  max-width: calc(100% - 2 * min(var(--tracker-side-gutter, 180px), 15%));
  margin-inline: auto;
  gap: 14px;
  background: var(--panel-background, #0c1018);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.06));
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  contain: layout style paint;
  will-change: auto;
}

.pattern-body {
  position: relative;
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 12px;
  width: 100%;
  contain: layout style;
}

/*
 * Playback buffers: two copies of the idle-mode content (row gutter + tracks)
 * stacked over each other inside one grid cell, so the flip is a pure
 * visibility change with zero layout shift. They must NOT be stacked
 * absolutely -- the pattern needs its natural height for the scroll area.
 */
.pattern-buffer {
  grid-column: 1 / -1;
  grid-row: 1;
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 12px;
  min-width: 0;
  /* Promote to its own compositor layer and keep it rasterized while hidden:
     the flip is then a compositor-only opacity change -- no paint at flip
     time, which is what caused a visible blank on dense (24-32ch) grids. */
  will-change: opacity;
  transform: translateZ(0);
}

.buffer-hidden {
  /* opacity:0 (NOT visibility:hidden): hidden content stays painted so the
     pattern swap shows an already-rasterized layer instantly. */
  opacity: 0;
  pointer-events: none;
}

.row-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: hidden;
  position: relative;
  z-index: 2;
  width: 78px;
  min-width: 78px;
  max-width: 78px;
  flex-shrink: 0;
}

.row-numbers-container {
  position: relative;
  flex-shrink: 0;
}

.row-numbers-viewport {
  display: flex;
  flex-direction: column;
  gap: 6px;
  will-change: transform;
  backface-visibility: hidden;
}

.row-header {
  height: 46px;
  min-height: 46px;
  max-height: 46px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--button-background, rgba(255, 255, 255, 0.04));
  color: var(--text-muted, #9fb3d3);
  font-family: var(--font-tracker);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
  box-sizing: border-box;
  flex-shrink: 0;
}

.row-number {
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  border-radius: 10px;
  border: 1px solid var(--tracker-border-default, rgba(255, 255, 255, 0.05));
  background: var(--tracker-entry-base, rgba(13, 17, 26, 0.92));
  color: var(--text-muted, #a7bcd8);
  font-family: var(--font-tracker);
  font-size: 12px;
  letter-spacing: 0.08em;
  cursor: pointer;
  /* Removed transitions for better performance */
  contain: layout style;
  box-sizing: border-box;
  flex-shrink: 0;
}

.row-number:focus {
  outline: none;
}

.row-number:hover {
  border-color: var(--tracker-border-hover, rgba(255, 255, 255, 0.12));
}

.row-number.in-selection {
  border-color: var(--tracker-selected-border, rgba(77, 242, 197, 0.8));
  background: var(--tracker-selected-bg, rgba(77, 242, 197, 0.14));
}

.row-number.selected {
  border-color: var(--panel-border, rgba(255, 255, 255, 0.25));
}

.row-playback-bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  border-radius: 10px;
  pointer-events: none;
  will-change: transform;
  z-index: 10;
  border: 2px solid var(--panel-border, rgba(255, 255, 255, 0.25));
  background: rgba(255, 255, 255, 0.05);
}

.playback-pattern .row-playback-bar {
  border-color: var(--tracker-accent-primary, rgb(77, 242, 197));
  background: var(--tracker-selected-bg, rgba(77, 242, 197, 0.14));
}

.playback-song .row-playback-bar {
  border-color: var(--tracker-accent-secondary, rgb(88, 176, 255));
  background: rgba(88, 176, 255, 0.14);
}

.tracks-wrapper {
  --tracker-track-width: 180px;
  --tracker-track-gap: 10px;
  display: flex;
  gap: var(--tracker-track-gap);
  overflow-x: auto;
  width: 100%;
  z-index: 1;
  position: relative;
  contain: layout style;
}

.active-row-bar {
  position: absolute;
  inset: 0 0 auto 0;
  border-radius: 10px;
  pointer-events: none;
  transition: none;
  will-change: transform;
  z-index: 10;
  border: 2px solid transparent;
  background: transparent;
}

.playback-pattern .active-row-bar {
  background: var(--tracker-selected-bg, rgba(77, 242, 197, 0.14));
  border: 2px solid var(--tracker-accent-primary, rgb(77, 242, 197));
}

.playback-song .active-row-bar {
  background: rgba(88, 176, 255, 0.14);
  border: 2px solid var(--tracker-accent-secondary, rgb(88, 176, 255));
}

/*
 * This element is as tall as the whole pattern, so its scrollbar renders at the
 * foot of that -- far below the visible area on anything but a short pattern.
 * TrackerPage draws a proxy bar pinned under the pattern area and keeps the two
 * in sync, so the real one is hidden rather than shown somewhere unreachable.
 */
.tracks-wrapper {
  scrollbar-width: none;
}

.tracks-wrapper::-webkit-scrollbar {
  height: 0;
  display: none;
}

@media (max-width: 900px) {
  .pattern-header {
    flex-direction: column;
    align-items: flex-start;
  }

  /* Stay a grid (not flex) so both playback buffers keep stacking in row 1
     -- a flex column would put the hidden buffer below the visible one and
     double the scroll height. Row placement reproduces the old mobile order:
     tracks above the row-number gutter. */
  .pattern-body {
    grid-template-columns: 1fr;
  }

  .pattern-buffer {
    grid-template-columns: 1fr;
  }

  .tracks-wrapper {
    grid-row: 1;
  }

  .row-column {
    grid-row: 2;
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .row-number {
    min-width: 60px;
  }

  .tracker-pattern {
    max-width: none;
  }
}
</style>

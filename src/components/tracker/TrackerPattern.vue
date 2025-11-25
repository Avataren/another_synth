<template>
  <div
    class="tracker-pattern"
    :class="{ 'playback-pattern': isPlaying && playbackMode === 'pattern', 'playback-song': isPlaying && playbackMode === 'song' }"
    :style="{
      '--tracker-row-height': rowHeight,
      '--tracker-header-height': headerHeight,
      '--tracker-accent': accentColor
    }"
  >
    <div class="pattern-body">
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
              ref="rowRefs"
            >
              {{ formatRow(row) }}
            </button>
          </div>
          <div class="row-playback-bar" :style="rowBarStyle"></div>
        </div>
      </div>

      <div class="tracks-wrapper" ref="tracksWrapperRef">
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
          @rowSelected="selectRow"
          @cellSelected="selectCell"
          @startSelection="startSelection"
          @hoverSelection="hoverSelection"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TrackerTrack from './TrackerTrack.vue';
import type { TrackerSelectionRect, TrackerTrackData } from './tracker-types';

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
}

const props = defineProps<Props>();

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
const accentColor = '#4df2c5';
const rowsList = computed(() => Array.from({ length: props.rows }, (_, idx) => idx));
const rowRefs = ref<(HTMLElement | null)[]>([]);
const tracksWrapperRef = ref<HTMLElement | null>(null);
const activeBarWidth = ref<number | null>(null);
const selectionRect = computed(() => props.selectionRect);

// Virtual scrolling - use scroll info from parent
const overscan = 5; // Extra rows to render above/below viewport

const visibleRange = computed(() => {
  const rowTotalHeight = rowHeightPx + rowGapPx;
  // Account for header height and padding in scroll offset calculation
  const adjustedScrollTop = Math.max(0, props.scrollTop - headerHeightPx - 18); // 18px is pattern padding
  const startRow = Math.max(0, Math.floor(adjustedScrollTop / rowTotalHeight) - overscan);
  const visibleRows = Math.ceil(props.containerHeight / rowTotalHeight) + overscan * 2;
  const endRow = Math.min(props.rows - 1, startRow + visibleRows);
  return { startRow, endRow };
});

// Only the visible rows for the row column
const visibleRowsList = computed(() => {
  const { startRow, endRow } = visibleRange.value;
  return Array.from({ length: endRow - startRow + 1 }, (_, idx) => startRow + idx);
});

// Total height of all rows for virtual scroll container
const totalRowsHeight = computed(() => props.rows * (rowHeightPx + rowGapPx));

// Offset for positioning visible rows
const rowsOffsetStyle = computed(() => ({
  transform: `translateY(${visibleRange.value.startRow * (rowHeightPx + rowGapPx)}px)`
}));

// During playback, don't propagate selectedRow changes to TrackerTrack/TrackerEntry
// The active-row-bar provides visual feedback instead, avoiding component re-renders
const effectiveSelectedRow = computed(() => props.isPlaying ? -1 : props.selectedRow);

// Scroll container ref (used for programmatic scrolling)
const patternAreaRef = ref<HTMLElement | null>(null);

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
    // Fallback to scrollIntoView
    const btn = rowRefs.value?.[row];
    if (btn) btn.scrollIntoView({ block: 'center', behavior: 'auto' });
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
  return props.selectedRow;
});

// Single watcher for both playback and selection scrolling
watch(scrollTarget, (row) => {
  if (row === null) return;
  scrollToRow(row);
});

const measureBarWidth = async () => {
  await nextTick();
  const wrapper = tracksWrapperRef.value;
  if (!wrapper) return;
  const tracks = wrapper.querySelectorAll<HTMLElement>('.tracker-track');
  if (tracks.length === 0) {
    activeBarWidth.value = wrapper.clientWidth;
    return;
  }
  const last = tracks[tracks.length - 1];
  if (last) {
    const width = last.offsetLeft + last.offsetWidth;
    activeBarWidth.value = width;
  }
};

watch(
  () => props.tracks.map((t: TrackerTrackData) => t.id).join(','),
  () => measureBarWidth(),
  { flush: 'post' }
);

watch(
  () => rowsList.value.length,
  () => measureBarWidth(),
  { flush: 'post' }
);

onMounted(() => {
  measureBarWidth();
  window.addEventListener('resize', measureBarWidth);

  // Find the scroll container (.pattern-area is in the parent)
  const trackerPattern = tracksWrapperRef.value?.closest('.tracker-pattern');
  if (trackerPattern) {
    patternAreaRef.value = trackerPattern.closest('.pattern-area') as HTMLElement | null;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', measureBarWidth);
});
</script>

<style scoped>
.tracker-pattern {
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--panel-background, #0c1018);
  border: 1px solid var(--panel-border, rgba(255, 255, 255, 0.06));
  border-radius: 16px;
  padding: 18px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.pattern-body {
  position: relative;
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 12px;
  width: 100%;
}

.row-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow-y: hidden;
  position: relative;
  z-index: 2;
}

.row-numbers-container {
  position: relative;
  flex-shrink: 0;
}

.row-numbers-viewport {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.row-header {
  height: var(--tracker-header-height);
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
}

.row-number {
  height: var(--tracker-row-height);
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
  padding-bottom: 4px;
  width: 100%;
  z-index: 1;
  position: relative;
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

.tracks-wrapper::-webkit-scrollbar {
  height: 10px;
}

.tracks-wrapper::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.08));
  border-radius: 999px;
}

.tracks-wrapper::-webkit-scrollbar-track {
  background: var(--input-background, rgba(255, 255, 255, 0.03));
  border-radius: 999px;
}

@media (max-width: 900px) {
  .pattern-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .pattern-body {
    display: flex;
    flex-direction: column;
  }

  .row-column {
    order: 2;
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .row-number {
    min-width: 60px;
  }

  .tracks-wrapper {
    order: 1;
    width: 100%;
  }
}
</style>

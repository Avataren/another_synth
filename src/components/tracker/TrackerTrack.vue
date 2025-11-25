<template>
  <div class="tracker-track" :style="{ '--track-accent': track.color || fallbackAccent }">
    <div class="track-header">
      <div class="track-name">{{ track.name }}</div>
      <div class="track-id">#{{ trackIndexLabel }}</div>
    </div>
    <div class="track-entries-container" :style="{ height: `${totalEntriesHeight}px` }">
      <div class="track-entries" :style="entriesOffsetStyle">
        <TrackerEntry
          v-for="row in visibleRows"
          :key="`${track.id}-${row}`"
          :row-index="row"
          :entry="entryLookup[row]"
          :active="selectedRow === row"
          :selected="isRowSelected(row)"
          :track-index="index"
          :active-track="activeTrack"
          :active-column="activeColumn"
          :active-macro-nibble="activeMacroNibble"
          @select-cell="onSelectCell"
          @start-selection="onStartSelection"
          @hover-selection="onHoverSelection"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TrackerEntry from './TrackerEntry.vue';
import type { TrackerEntryData, TrackerSelectionRect, TrackerTrackData } from './tracker-types';

interface Props {
  track: TrackerTrackData;
  rowCount: number;
  selectedRow: number;
  index: number;
  activeTrack: number;
  activeColumn: number;
  activeMacroNibble: number;
  selectionRect?: TrackerSelectionRect | null;
  visibleStartRow: number;
  visibleEndRow: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number }): void;
  (event: 'startSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'hoverSelection', payload: { row: number; trackIndex: number }): void;
}>();

const rowHeightPx = 30;
const rowGapPx = 6;

// Only render visible rows (virtual scrolling)
const visibleRows = computed(() => {
  const { visibleStartRow, visibleEndRow } = props;
  return Array.from({ length: visibleEndRow - visibleStartRow + 1 }, (_, idx) => visibleStartRow + idx);
});

// Total height of all entries for virtual scroll container
const totalEntriesHeight = computed(() => props.rowCount * (rowHeightPx + rowGapPx));

// Offset for positioning visible entries
const entriesOffsetStyle = computed(() => ({
  transform: `translateY(${props.visibleStartRow * (rowHeightPx + rowGapPx)}px)`
}));

const entryLookup = computed<Record<number, TrackerEntryData | undefined>>(() => {
  const lookup: Record<number, TrackerEntryData | undefined> = {};
  for (const entry of props.track.entries) {
    if (entry.row >= 0 && entry.row < props.rowCount) {
      lookup[entry.row] = entry;
    }
  }
  return lookup;
});

const trackIndexLabel = computed(() => (props.index + 1).toString().padStart(2, '0'));

const fallbackAccent = '#5dd6ff';

// Pre-compute selected rows as a Set for O(1) lookup instead of O(n) function calls
const selectedRows = computed(() => {
  if (!props.selectionRect) return new Set<number>();
  const { rowStart, rowEnd, trackStart, trackEnd } = props.selectionRect;

  // If this track is not in the selection range, return empty set
  if (props.index < trackStart || props.index > trackEnd) {
    return new Set<number>();
  }

  // Build set of selected row indices
  const rows = new Set<number>();
  for (let r = rowStart; r <= rowEnd; r++) {
    rows.add(r);
  }
  return rows;
});

function onSelectCell(payload: { row: number; column: number; trackIndex: number }) {
  emit('cellSelected', payload);
}

function isRowSelected(row: number) {
  return selectedRows.value.has(row);
}

function onStartSelection(payload: { row: number; trackIndex: number }) {
  emit('startSelection', payload);
}

function onHoverSelection(payload: { row: number; trackIndex: number }) {
  emit('hoverSelection', payload);
}
</script>

<style scoped>
.tracker-track {
  --track-accent: #5dd6ff;
  min-width: var(--tracker-track-width, 180px);
  background: linear-gradient(180deg, rgba(19, 26, 38, 0.9), rgba(12, 16, 24, 0.9));
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  overflow: hidden;
  backdrop-filter: blur(6px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.35);
}

.track-header {
  height: var(--tracker-header-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 14px;
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0));
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  color: #e6f2ff;
  text-transform: uppercase;
  font-family: var(--font-tracker);
  letter-spacing: 0.04em;
}

.track-name {
  font-weight: 700;
  font-size: 12px;
}

.track-id {
  color: rgba(255, 255, 255, 0.66);
  font-weight: 600;
  font-size: 11px;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
}

.track-entries-container {
  position: relative;
  padding: 6px 12px 14px;
  overflow: hidden;
}

.track-entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>

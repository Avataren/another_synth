<template>
  <div
    class="tracker-pattern"
    :style="{
      '--tracker-row-height': rowHeight,
      '--tracker-header-height': headerHeight,
      '--tracker-accent': accentColor
    }"
  >
    <div class="pattern-body">
      <div class="row-column">
        <div class="row-header">Row</div>
        <button
          v-for="row in rowsList"
          :key="row"
          type="button"
          class="row-number"
          :class="{
            playing: isPlaying && playbackRow === row,
            selected: effectiveSelectedRow === row
          }"
          @click="selectRow(row)"
          ref="rowRefs"
        >
          {{ formatRow(row) }}
        </button>
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
          @rowSelected="selectRow"
          @cellSelected="selectCell"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import TrackerTrack from './TrackerTrack.vue';
import type { TrackerTrackData } from './tracker-types';

interface Props {
  tracks: TrackerTrackData[];
  rows: number;
  selectedRow: number;
  playbackRow: number;
  activeTrack: number;
  activeColumn: number;
  autoScroll: boolean;
  isPlaying: boolean;
  activeMacroNibble: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number; macroNibble?: number }): void;
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

// During playback, don't propagate selectedRow changes to TrackerTrack/TrackerEntry
// The active-row-bar provides visual feedback instead, avoiding component re-renders
const effectiveSelectedRow = computed(() => props.isPlaying ? -1 : props.selectedRow);

// Scroll container ref
const patternAreaRef = ref<HTMLElement | null>(null);

const activeBarStyle = computed(() => {
  const offset = headerHeightPx + 6 + props.playbackRow * (rowHeightPx + rowGapPx);
  return {
    transform: `translateY(${offset}px)`,
    height: rowHeight
    ,
    width: activeBarWidth.value ? `${activeBarWidth.value}px` : '100%'
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

// Track which row we last scrolled to
let lastScrolledRow = -1;

// Scroll for playback position - snap to row
watch(
  () => props.playbackRow,
  (row) => {
    if (!props.autoScroll) return;
    if (row === lastScrolledRow) return;
    lastScrolledRow = row;
    scrollToRow(row);
  }
);

// Scroll for selected row (keyboard navigation, clicking)
watch(
  () => props.selectedRow,
  (row) => {
    if (!props.autoScroll) return;
    if (props.isPlaying) return; // Don't interfere during playback
    if (row === lastScrolledRow) return;
    lastScrolledRow = row;
    scrollToRow(row);
  }
);

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
  background: radial-gradient(160% 120% at 80% 10%, rgba(77, 242, 197, 0.08), transparent),
    radial-gradient(160% 160% at 10% 20%, rgba(80, 170, 255, 0.07), transparent),
    linear-gradient(180deg, #0c1018, #0b0f17);
  border: 1px solid rgba(255, 255, 255, 0.06);
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
  overflow-y: auto;
  position: relative;
  z-index: 2;
}

.row-header {
  height: var(--tracker-header-height);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  color: #9fb3d3;
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  font-weight: 700;
}

.row-number {
  height: var(--tracker-row-height);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  background: rgba(13, 17, 26, 0.92);
  color: #a7bcd8;
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  font-size: 12px;
  letter-spacing: 0.08em;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease;
}

.row-number:hover {
  border-color: rgba(255, 255, 255, 0.12);
}

.row-number.playing {
  color: #0c1624;
  font-weight: 800;
  background: linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9));
  border-color: transparent;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.row-number.selected {
  border-color: rgba(255, 255, 255, 0.25);
}

.tracks-wrapper {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
  width: 100%;
  z-index: 1;
  position: relative;
}

.active-row-bar {
  position: absolute;
  inset: 0 0 auto 0;
  background: linear-gradient(90deg, rgba(77, 242, 197, 0.18), rgba(88, 176, 255, 0.22));
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  pointer-events: none;
  transition: none;
  will-change: transform;
}

.tracks-wrapper::-webkit-scrollbar {
  height: 10px;
}

.tracks-wrapper::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.08);
  border-radius: 999px;
}

.tracks-wrapper::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.03);
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

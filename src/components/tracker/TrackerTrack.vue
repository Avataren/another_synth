<template>
  <div class="tracker-track" :style="{ '--track-accent': track.color || fallbackAccent }">
    <div class="track-header">
      <div class="track-name">{{ track.name }}</div>
      <div class="track-id">#{{ trackIndexLabel }}</div>
    </div>
    <div class="track-entries">
      <TrackerEntry
        v-for="row in rows"
        :key="`${track.id}-${row}`"
        :row-index="row"
        :entry="entryLookup[row]"
        :active="activeRow === row"
        :accent-color="track.color"
        :track-index="index"
        :active-track="activeTrack"
        :active-column="activeColumn"
        @select-cell="onSelectCell"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TrackerEntry from './TrackerEntry.vue';
import type { TrackerEntryData, TrackerTrackData } from './tracker-types';

interface Props {
  track: TrackerTrackData;
  rowCount: number;
  activeRow: number;
  index: number;
  activeTrack: number;
  activeColumn: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number }): void;
}>();

const rows = computed(() => Array.from({ length: props.rowCount }, (_, idx) => idx));

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

function onSelectCell(payload: { row: number; column: number; trackIndex: number }) {
  emit('cellSelected', payload);
}
</script>

<style scoped>
.tracker-track {
  --track-accent: #5dd6ff;
  min-width: 180px;
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
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
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

.track-entries {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 12px 14px;
  background-image: linear-gradient(
    180deg,
    rgba(255, 255, 255, 0.03) 0,
    rgba(255, 255, 255, 0.03) 1px,
    transparent 1px,
    transparent var(--tracker-row-height)
  );
}
</style>

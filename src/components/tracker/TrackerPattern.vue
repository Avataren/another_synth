<template>
  <div
    class="tracker-pattern"
    :style="{
      '--tracker-row-height': rowHeight,
      '--tracker-header-height': headerHeight,
      '--tracker-accent': accentColor
    }"
  >
    <div class="pattern-header">
      <div class="eyebrow">Pattern</div>
      <div class="row-control">
        <div class="label">Active row</div>
        <div class="control">
          <button type="button" class="control-button" @click="nudgeRow(-1)">
            -
          </button>
          <div class="row-indicator">{{ formattedActiveRow }}</div>
          <button type="button" class="control-button" @click="nudgeRow(1)">
            +
          </button>
        </div>
      </div>
    </div>

    <div class="pattern-body">
      <div class="row-column">
        <div class="row-header">Row</div>
        <button
          v-for="row in rowsList"
          :key="row"
          type="button"
          class="row-number"
          :class="{ active: activeRow === row }"
          @click="selectRow(row)"
        >
          {{ formatRow(row) }}
        </button>
      </div>

      <div class="tracks-wrapper">
        <TrackerTrack
          v-for="(track, index) in tracks"
          :key="track.id"
          :track="track"
          :row-count="rows"
          :active-row="activeRow"
          :index="index"
          :active-track="activeTrack"
          :active-column="activeColumn"
          @rowSelected="selectRow"
          @cellSelected="selectCell"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import TrackerTrack from './TrackerTrack.vue';
import type { TrackerTrackData } from './tracker-types';

interface Props {
  tracks: TrackerTrackData[];
  rows: number;
  activeRow: number;
  activeTrack: number;
  activeColumn: number;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (event: 'rowSelected', row: number): void;
  (event: 'cellSelected', payload: { row: number; column: number; trackIndex: number }): void;
}>();

const rowsList = computed(() => Array.from({ length: props.rows }, (_, idx) => idx));

const rowHeight = '30px';
const headerHeight = '46px';
const accentColor = '#4df2c5';

const formattedActiveRow = computed(() => formatRow(props.activeRow));

function formatRow(row: number) {
  return row.toString(16).toUpperCase().padStart(2, '0');
}

function selectRow(row: number) {
  emit('rowSelected', row);
}

function selectCell(payload: { row: number; column: number; trackIndex: number }) {
  emit('cellSelected', payload);
}

function nudgeRow(direction: number) {
  const count = Math.max(props.rows, 1);
  const clamped = (props.activeRow + direction + count) % count;
  emit('rowSelected', clamped);
}
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

.pattern-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
}

.eyebrow {
  color: #9cc7ff;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 6px;
}

.row-control {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}

.row-control .label {
  color: #9fb3d3;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 6px 8px;
}

.control-button {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(14, 19, 28, 0.9);
  color: #d8e7ff;
  cursor: pointer;
  font-weight: 800;
  transition: border-color 120ms ease, transform 80ms ease;
}

.control-button:hover {
  border-color: var(--tracker-accent);
}

.control-button:active {
  transform: translateY(1px);
}

.row-indicator {
  width: 48px;
  text-align: center;
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  font-size: 15px;
  color: #0c1624;
  font-weight: 800;
  background: linear-gradient(90deg, #4df2c5, #70c2ff);
  border-radius: 10px;
  padding: 6px 10px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.3);
}

.pattern-body {
  display: grid;
  grid-template-columns: 78px 1fr;
  gap: 12px;
}

.row-column {
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

.row-number.active {
  color: #0c1624;
  font-weight: 800;
  background: linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9));
  border-color: transparent;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.tracks-wrapper {
  display: flex;
  gap: 10px;
  overflow-x: auto;
  padding-bottom: 4px;
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

  .row-control {
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
  }
}
</style>

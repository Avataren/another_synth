<template>
  <q-page class="tracker-page">
    <div class="tracker-container">
      <div class="page-header">
        <div>
          <div class="eyebrow">Tracker</div>
          <div class="stats">
            <div class="stat-chip">
              <div class="stat-label">Tracks</div>
              <div class="stat-value">{{ tracks.length }}</div>
            </div>
            <div class="stat-chip">
              <div class="stat-label">Rows</div>
              <div class="stat-value">{{ rows }}</div>
            </div>
            <div class="stat-chip">
              <div class="stat-label">Current row</div>
              <div class="stat-value">{{ activeRowDisplay }}</div>
            </div>
          </div>
        </div>
      </div>

      <TrackerPattern
        :tracks="tracks"
        :rows="rows"
        :active-row="activeRow"
        @rowSelected="setActiveRow"
      />
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import TrackerPattern from 'src/components/tracker/TrackerPattern.vue';
import type { TrackerTrackData } from 'src/components/tracker/tracker-types';

const rows = 16;
const activeRow = ref(0);

const tracks = ref<TrackerTrackData[]>([
  {
    id: 'T01',
    name: 'Track 1',
    color: '#4df2c5',
    entries: [
      { row: 0, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 4, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 8, note: 'C-2', instrument: '01', volume: '7F' },
      { row: 12, note: 'C-2', instrument: '01', volume: '7F' }
    ]
  },
  {
    id: 'T02',
    name: 'Track 2',
    color: '#9da6ff',
    entries: [
      { row: 4, note: 'D-2', instrument: '02', volume: '70' },
      { row: 12, note: 'D-2', instrument: '02', volume: '70' }
    ]
  },
  {
    id: 'T03',
    name: 'Track 3',
    color: '#ffde7b',
    entries: [
      { row: 2, note: 'F#2', instrument: '03', volume: '60' },
      { row: 6, note: 'F#2', instrument: '03', volume: '60' },
      { row: 10, note: 'F#2', instrument: '03', volume: '60' },
      { row: 14, note: 'F#2', instrument: '03', volume: '60' }
    ]
  },
  {
    id: 'T04',
    name: 'Track 4',
    color: '#70c2ff',
    entries: [
      { row: 0, note: 'C-3', instrument: '04', volume: '68', effect: 'GLD' },
      { row: 4, note: 'G-2', instrument: '04', volume: '64' },
      { row: 8, note: 'A-2', instrument: '04', volume: '64', effect: 'SLD' },
      { row: 12, note: 'G-2', instrument: '04', volume: '64' }
    ]
  },
  {
    id: 'T05',
    name: 'Track 5',
    color: '#ff9db5',
    entries: [
      { row: 2, note: 'E-4', instrument: '05', volume: '70', effect: 'VIB' },
      { row: 6, note: 'G-4', instrument: '05', volume: '70' },
      { row: 10, note: 'B-3', instrument: '05', volume: '70' },
      { row: 14, note: 'A-3', instrument: '05', volume: '70', effect: 'SLD' }
    ]
  },
  {
    id: 'T06',
    name: 'Track 6',
    color: '#8ef5c5',
    entries: [
      { row: 0, note: 'C-4', instrument: '06', volume: '50' },
      { row: 8, note: 'F-3', instrument: '06', volume: '50' }
    ]
  },
  {
    id: 'T07',
    name: 'Track 7',
    color: '#ffa95e',
    entries: [
      { row: 7, note: 'G-5', instrument: '07', volume: '40', effect: 'ECO' },
      { row: 15, note: 'C-5', instrument: '07', volume: '40', effect: 'ECO' }
    ]
  },
  {
    id: 'T08',
    name: 'Track 8',
    color: '#b08bff',
    entries: [
      { row: 3, note: 'A#2', instrument: '08', volume: '55' },
      { row: 11, note: 'G#2', instrument: '08', volume: '55' }
    ]
  }
]);

const activeRowDisplay = computed(() => activeRow.value.toString(16).toUpperCase().padStart(2, '0'));

function setActiveRow(row: number) {
  activeRow.value = row;
}
</script>

<style scoped>
.tracker-page {
  min-height: var(--q-page-container-height, 100vh);
  background: radial-gradient(120% 140% at 20% 20%, rgba(80, 170, 255, 0.1), transparent),
    radial-gradient(120% 120% at 80% 10%, rgba(255, 147, 204, 0.1), transparent),
    linear-gradient(135deg, #0c111b, #0b0f18 55%, #0d1320);
  padding: 28px 18px 36px;
  box-sizing: border-box;
}

.tracker-container {
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}

.eyebrow {
  color: #9cc7ff;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-weight: 700;
  margin-bottom: 4px;
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  max-width: 520px;
}

.stat-chip {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  padding: 10px 12px;
  color: #cfe4ff;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
}

.stat-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #9fb3d3;
}

.stat-value {
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

@media (max-width: 900px) {
  .page-header {
    flex-direction: column;
    gap: 12px;
  }
}
</style>

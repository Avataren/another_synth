<template>
  <q-page class="ahx-page" data-testid="ahx-instrument-display">
    <div class="ahx-banner">
      <div class="ahx-banner__info">
        <q-icon name="visibility" size="sm" />
        <span class="ahx-banner__label">AHX Instrument</span>
        <span v-if="slotNumber !== null" class="ahx-banner__slot"
          >Slot #{{ formatInstrumentId(slotNumber) }}</span
        >
        <span class="ahx-banner__name" data-testid="ahx-instrument-name">{{
          displayName
        }}</span>
        <span
          class="ahx-banner__readonly"
          title="AHX songs play from the file. Editing arrives in a later phase."
          >Read-only</span
        >
      </div>
      <q-btn
        flat
        dense
        color="white"
        icon="arrow_back"
        label="Back to Tracker"
        title="Press Escape to return"
        @click="backToTracker"
      />
    </div>

    <div v-if="!instrument" class="ahx-empty" data-testid="ahx-instrument-missing">
      This slot has no AHX instrument. Load an AHX song in the tracker and open
      one of its instruments from the list.
    </div>

    <div v-else class="ahx-body">
      <section class="ahx-card">
        <h3>Instrument</h3>
        <dl class="ahx-params" data-testid="ahx-params">
          <div><dt>Volume</dt><dd>{{ instrument.volume }} / 64</dd></div>
          <div>
            <dt>Wave length</dt>
            <dd>
              {{ instrument.waveLength }}
              <span class="ahx-dim">({{ cycleLength }} samples)</span>
            </dd>
          </div>
          <div>
            <dt>Vibrato</dt>
            <dd>
              delay {{ instrument.vibratoDelay }}, speed
              {{ instrument.vibratoSpeed }}, depth {{ instrument.vibratoDepth }}
            </dd>
          </div>
          <div>
            <dt>Square modulation</dt>
            <dd>
              {{ instrument.squareLowerLimit }}–{{ instrument.squareUpperLimit }},
              speed {{ instrument.squareSpeed }}
            </dd>
          </div>
          <div>
            <dt>Filter modulation</dt>
            <dd>
              {{ instrument.filterLowerLimit }}–{{ instrument.filterUpperLimit }},
              speed {{ instrument.filterSpeed }}
            </dd>
          </div>
          <div>
            <dt>Hard cut release</dt>
            <dd>
              {{
                instrument.hardCutRelease
                  ? `on, ${instrument.hardCutReleaseFrames} frames`
                  : 'off'
              }}
            </dd>
          </div>
        </dl>
      </section>

      <section class="ahx-card">
        <h3>Volume envelope</h3>
        <svg
          class="ahx-envelope"
          data-testid="ahx-envelope"
          :viewBox="`0 0 ${ENV_W} ${ENV_H}`"
          preserveAspectRatio="none"
          role="img"
          aria-label="Volume envelope"
        >
          <line class="ahx-envelope__axis" :x1="0" :y1="ENV_H" :x2="ENV_W" :y2="ENV_H" />
          <polyline class="ahx-envelope__line" :points="envelopePolyline" />
        </svg>
        <table class="ahx-table ahx-table--compact" data-testid="ahx-envelope-table">
          <thead>
            <tr><th>Stage</th><th>Frames</th><th>Volume</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Attack</td>
              <td>{{ instrument.envelope.aFrames }}</td>
              <td>{{ instrument.envelope.aVolume }}</td>
            </tr>
            <tr>
              <td>Decay</td>
              <td>{{ instrument.envelope.dFrames }}</td>
              <td>{{ instrument.envelope.dVolume }}</td>
            </tr>
            <tr>
              <td>Sustain</td>
              <td>{{ instrument.envelope.sFrames }}</td>
              <td class="ahx-dim">holds</td>
            </tr>
            <tr>
              <td>Release</td>
              <td>{{ instrument.envelope.rFrames }}</td>
              <td>{{ instrument.envelope.rVolume }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="ahx-card">
        <h3>Waveforms</h3>
        <ul v-if="waveforms.length" class="ahx-waves" data-testid="ahx-waveforms">
          <li v-for="wave in waveforms" :key="wave.field" class="ahx-wave">
            <svg class="ahx-wave__glyph" viewBox="0 0 32 16" aria-hidden="true">
              <path :d="WAVE_GLYPH[wave.kind]" />
            </svg>
            <span class="ahx-wave__name">{{ waveLabel(wave.field) }}</span>
            <span class="ahx-dim"
              >first at row {{ hex2(wave.firstRow) }}, used {{ wave.count }}×</span
            >
          </li>
        </ul>
        <p v-else class="ahx-dim">The PList selects no waveform.</p>
      </section>

      <section class="ahx-card ahx-card--wide">
        <h3>
          PList
          <span class="ahx-dim" data-testid="ahx-plist-summary"
            >{{ instrument.plist.entries.length }} rows, speed
            {{ instrument.plist.speed }}</span
          >
        </h3>
        <div v-if="plistRows.length" class="ahx-plist-scroll">
          <table class="ahx-table" data-testid="ahx-plist">
            <thead>
              <tr>
                <th>Row</th><th>Note</th><th>Waveform</th><th>FX 1</th><th>FX 2</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in plistRows" :key="row.index">
                <td class="ahx-dim">{{ hex2(row.index) }}</td>
                <td>{{ row.note }}<span v-if="row.fixed" class="ahx-dim"> fixed</span></td>
                <td>{{ row.waveform }}</td>
                <td v-for="(fx, i) in row.fx" :key="i" :title="fx.name">{{ fx.text }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="ahx-dim">This instrument has no PList.</p>
      </section>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { formatInstrumentId } from '@another-synth/tracker-playback';
import { useTrackerStore } from 'src/stores/tracker-store';
import {
  AHX_MAX_VOLUME,
  ahxEnvelopePoints,
  ahxPListRows,
  ahxWaveCycleLength,
  ahxWaveformLabel,
  ahxWaveformList,
  type AhxWaveformKind,
} from 'src/audio/tracker/ahx-instrument-display';

const route = useRoute();
const router = useRouter();
const trackerStore = useTrackerStore();

const ENV_W = 240;
const ENV_H = 80;

const slotNumber = computed<number | null>(() => {
  const raw = Array.isArray(route.params.slot) ? route.params.slot[0] : route.params.slot;
  const parsed = parseInt(String(raw ?? ''), 10);
  return Number.isNaN(parsed) ? null : parsed;
});

const slot = computed(() =>
  trackerStore.instrumentSlots.find((s) => s.slot === slotNumber.value),
);
const instrument = computed(() => slot.value?.ahxData ?? null);
const displayName = computed(
  () => slot.value?.instrumentName || slot.value?.patchName || 'Empty',
);

const cycleLength = computed(() =>
  instrument.value ? ahxWaveCycleLength(instrument.value.waveLength) : 0,
);
const waveforms = computed(() =>
  instrument.value ? ahxWaveformList(instrument.value) : [],
);
const plistRows = computed(() =>
  instrument.value ? ahxPListRows(instrument.value.plist.entries) : [],
);

/** Envelope scaled into the SVG box: time along x, volume 0..64 up y. */
const envelopePolyline = computed(() => {
  if (!instrument.value) return '';
  const points = ahxEnvelopePoints(instrument.value.envelope);
  const totalFrames = Math.max(1, points[points.length - 1]?.frame ?? 1);
  return points
    .map((p) => {
      const x = (p.frame / totalFrames) * ENV_W;
      const y = ENV_H - (p.volume / AHX_MAX_VOLUME) * ENV_H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});

const WAVE_GLYPH: Record<AhxWaveformKind | 'unknown', string> = {
  triangle: 'M0 8 L8 1 L24 15 L32 8',
  sawtooth: 'M0 15 L16 1 L16 15 L32 1',
  square: 'M0 15 L0 2 L16 2 L16 14 L32 14 L32 2',
  noise: 'M0 8 L3 3 L5 13 L8 6 L11 14 L14 2 L17 11 L20 4 L23 13 L26 5 L29 12 L32 8',
  unknown: 'M0 8 L32 8',
};

const waveLabel = ahxWaveformLabel;
const hex2 = (n: number): string => n.toString(16).toUpperCase().padStart(2, '0');

function backToTracker() {
  void router.push('/tracker');
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault();
    backToTracker();
  }
}

onMounted(() => window.addEventListener('keydown', handleKeyDown));
onUnmounted(() => window.removeEventListener('keydown', handleKeyDown));
</script>

<style scoped>
.ahx-page {
  background: var(--app-background, #0b111a);
  color: var(--text-primary, #e8f3ff);
}

.ahx-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  background: linear-gradient(
    90deg,
    var(--tracker-active-bg, #14283d),
    var(--button-background, #1a2534)
  );
  border-bottom: 1px solid var(--tracker-accent-secondary, #3b82a0);
}

.ahx-banner__info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ahx-banner__label {
  font-weight: 600;
}

.ahx-banner__slot,
.ahx-dim {
  opacity: 0.65;
}

.ahx-banner__name {
  font-weight: 600;
}

.ahx-banner__readonly {
  padding: 1px 8px;
  border: 1px solid currentColor;
  border-radius: 10px;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.8;
}

.ahx-empty {
  padding: 32px 24px;
  opacity: 0.75;
}

.ahx-body {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 12px;
  padding: 12px;
}

.ahx-card {
  padding: 12px 14px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}

.ahx-card--wide {
  grid-column: 1 / -1;
}

.ahx-card h3 {
  margin: 0 0 8px;
  font-size: 0.95rem;
  font-weight: 600;
}

.ahx-card h3 .ahx-dim {
  margin-left: 8px;
  font-size: 0.8rem;
  font-weight: 400;
}

.ahx-params {
  margin: 0;
  display: grid;
  gap: 4px;
}

.ahx-params > div {
  display: flex;
  gap: 12px;
}

.ahx-params dt {
  flex: 0 0 140px;
  opacity: 0.65;
}

.ahx-params dd {
  margin: 0;
}

.ahx-envelope {
  width: 100%;
  height: 90px;
  margin-bottom: 8px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 4px;
}

.ahx-envelope__axis {
  stroke: rgba(255, 255, 255, 0.2);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.ahx-envelope__line {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.ahx-waves {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.ahx-wave {
  display: flex;
  align-items: center;
  gap: 10px;
}

.ahx-wave__glyph {
  width: 40px;
  height: 20px;
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
}

.ahx-wave__name {
  min-width: 70px;
}

.ahx-plist-scroll {
  max-height: 420px;
  overflow-y: auto;
}

.ahx-table {
  border-collapse: collapse;
  font-family: var(--tracker-font, monospace);
  font-size: 0.85rem;
}

.ahx-table th,
.ahx-table td {
  padding: 2px 14px 2px 0;
  text-align: left;
  white-space: nowrap;
}

.ahx-table th {
  position: sticky;
  top: 0;
  opacity: 0.65;
  font-weight: 500;
  background: var(--app-background, #0b111a);
}

.ahx-table--compact th {
  position: static;
}
</style>

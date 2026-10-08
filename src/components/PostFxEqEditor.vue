<template>
  <!--
    Curve editor for the post-fx graphic EQ: the drawn line is the real combined
    response; drag a node up or down to set its band's gain. Double-click a node
    to flatten it. Arrow keys nudge the focused node.
  -->
  <div class="eq-editor">
    <div class="eq-header">
      <span class="eq-title">Equalizer</span>
      <button
        type="button"
        class="eq-toggle"
        :class="{ active: enabled }"
        @click="postFxStore.setEqEnabled(!enabled)"
      >
        {{ enabled ? 'ON' : 'OFF' }}
      </button>
      <button type="button" class="eq-reset" @click="postFxStore.resetEqToDefaults()">
        Flat
      </button>
    </div>
    <svg
      ref="svgRef"
      class="eq-svg"
      :class="{ disabled: !enabled }"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="none"
      @pointermove="onPointerMove"
      @pointerup="endDrag"
      @pointercancel="endDrag"
    >
      <line
        v-for="db in GRID_DB"
        :key="`g${db}`"
        class="eq-grid"
        :class="{ zero: db === 0 }"
        :x1="0"
        :x2="W"
        :y1="dbToY(db)"
        :y2="dbToY(db)"
      />
      <line
        v-for="(f, i) in EQ_BAND_FREQUENCIES"
        :key="`v${i}`"
        class="eq-grid"
        :x1="freqToX(f)"
        :x2="freqToX(f)"
        :y1="0"
        :y2="H"
      />
      <path class="eq-fill" :d="fillPath" />
      <path class="eq-curve" :d="curvePath" />
      <g
        v-for="(f, i) in EQ_BAND_FREQUENCIES"
        :key="`n${i}`"
        class="eq-node"
        :class="{ dragging: dragIndex === i }"
        tabindex="0"
        role="slider"
        :aria-label="`${formatFreq(f)} gain`"
        :aria-valuemin="EQ_MIN_GAIN_DB"
        :aria-valuemax="EQ_MAX_GAIN_DB"
        :aria-valuenow="gains[i] ?? 0"
        @pointerdown.prevent="startDrag(i, $event)"
        @dblclick="setGain(i, 0)"
        @keydown="onKey(i, $event)"
      >
        <circle class="eq-hit" :cx="freqToX(f)" :cy="dbToY(gains[i]!)" r="16" />
        <circle class="eq-dot" :cx="freqToX(f)" :cy="dbToY(gains[i]!)" r="6" />
      </g>
    </svg>
    <div class="eq-axis">
      <span v-for="(f, i) in EQ_BAND_FREQUENCIES" :key="i" class="eq-freq">
        {{ formatFreq(f) }}
      </span>
    </div>
    <div class="eq-readout">{{ readout }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  EQ_BAND_FREQUENCIES,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  eqEffectiveGains,
  eqResponseDb,
} from '@another-synth/tracker-playback';
import { usePostFxStore } from 'src/stores/post-fx-store';

const W = 400;
const H = 160;
const GRID_DB = [-12, -6, 0, 6, 12];
const LOG_MIN = Math.log10(20);
const LOG_MAX = Math.log10(20000);
const CURVE_POINTS = 160;

const postFxStore = usePostFxStore();
const enabled = computed(() => postFxStore.eqEnabled);
const gains = computed(() => postFxStore.eqParams.gainsDb);

const svgRef = ref<SVGSVGElement | null>(null);
const dragIndex = ref<number | null>(null);

function freqToX(f: number): number {
  return ((Math.log10(f) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * W;
}
function dbToY(db: number): number {
  return ((EQ_MAX_GAIN_DB - db) / (EQ_MAX_GAIN_DB - EQ_MIN_GAIN_DB)) * H;
}

const curveFrequencies = Array.from(
  { length: CURVE_POINTS },
  (_, i) => Math.pow(10, LOG_MIN + (i / (CURVE_POINTS - 1)) * (LOG_MAX - LOG_MIN)),
);

const curvePoints = computed(() => {
  const response = eqResponseDb(
    eqEffectiveGains({ gainsDb: gains.value }),
    curveFrequencies,
  );
  return curveFrequencies.map((f, i) => {
    const db = Math.min(EQ_MAX_GAIN_DB, Math.max(EQ_MIN_GAIN_DB, response[i]!));
    return [freqToX(f), dbToY(db)] as const;
  });
});

const curvePath = computed(() =>
  curvePoints.value
    .map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(' '),
);
const fillPath = computed(
  () => `${curvePath.value} L${W},${dbToY(0)} L0,${dbToY(0)} Z`,
);

function formatFreq(f: number): string {
  return f >= 1000 ? `${f / 1000}k` : String(f);
}

const readout = computed(() => {
  const i = dragIndex.value;
  if (i === null) return 'Drag the nodes · double-click to reset a band';
  const g = gains.value[i]!;
  return `${formatFreq(EQ_BAND_FREQUENCIES[i]!)} Hz: ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
});

function setGain(index: number, db: number): void {
  const next = [...postFxStore.eqParams.gainsDb];
  next[index] = Math.round(db * 2) / 2;
  postFxStore.setEqParams({ gainsDb: next });
  // Touching a band implies you want to hear it.
  if (!postFxStore.eqEnabled) postFxStore.setEqEnabled(true);
}

function startDrag(index: number, event: PointerEvent): void {
  dragIndex.value = index;
  svgRef.value?.setPointerCapture(event.pointerId);
  onPointerMove(event);
}

function onPointerMove(event: PointerEvent): void {
  const index = dragIndex.value;
  const svg = svgRef.value;
  if (index === null || !svg) return;
  const rect = svg.getBoundingClientRect();
  if (rect.height <= 0) return;
  const t = (event.clientY - rect.top) / rect.height;
  const db = EQ_MAX_GAIN_DB - t * (EQ_MAX_GAIN_DB - EQ_MIN_GAIN_DB);
  setGain(index, Math.min(EQ_MAX_GAIN_DB, Math.max(EQ_MIN_GAIN_DB, db)));
}

function endDrag(event: PointerEvent): void {
  if (dragIndex.value === null) return;
  svgRef.value?.releasePointerCapture(event.pointerId);
  dragIndex.value = null;
}

function onKey(index: number, event: KeyboardEvent): void {
  const step = event.shiftKey ? 3 : 0.5;
  if (event.key === 'ArrowUp') setGain(index, gains.value[index]! + step);
  else if (event.key === 'ArrowDown') setGain(index, gains.value[index]! - step);
  else if (event.key === 'Delete' || event.key === '0') setGain(index, 0);
  else return;
  event.preventDefault();
}
</script>

<style scoped>
.eq-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.eq-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.eq-title {
  flex: 1;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.7);
}
.eq-toggle,
.eq-reset {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.6);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  cursor: pointer;
}
.eq-toggle.active {
  background: rgba(120, 220, 160, 0.14);
  border-color: rgba(120, 220, 160, 0.4);
  color: #8fe3b4;
}
.eq-svg {
  width: 100%;
  height: 160px;
  background: #14171b;
  border-radius: 6px;
  touch-action: none;
  user-select: none;
}
.eq-svg.disabled .eq-curve {
  stroke: rgba(255, 255, 255, 0.35);
}
.eq-svg.disabled .eq-fill {
  fill: rgba(255, 255, 255, 0.04);
}
.eq-svg.disabled .eq-dot {
  fill: #6b7076;
}
.eq-grid {
  stroke: rgba(255, 255, 255, 0.07);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.eq-grid.zero {
  stroke: rgba(255, 255, 255, 0.22);
}
.eq-curve {
  fill: none;
  stroke: #ffb347;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.eq-fill {
  fill: rgba(255, 179, 71, 0.12);
  stroke: none;
}
.eq-node {
  cursor: ns-resize;
  outline: none;
}
.eq-hit {
  fill: transparent;
}
.eq-dot {
  fill: #ffcf87;
  stroke: #14171b;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.eq-node:hover .eq-dot,
.eq-node:focus-visible .eq-dot,
.eq-node.dragging .eq-dot {
  fill: #fff;
}
.eq-axis {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: rgba(255, 255, 255, 0.5);
  font-variant-numeric: tabular-nums;
}
.eq-readout {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.6);
  min-height: 13px;
}
</style>

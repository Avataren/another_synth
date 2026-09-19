<template>
  <div class="ahx-lane" data-testid="ahx-vibrato-lane">
    <svg
      class="ahx-lane__svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      :aria-label="summary"
    >
      <line class="ahx-lane__zero" :x1="LEFT" :x2="WIDTH" :y1="midY" :y2="midY" />
      <text class="ahx-lane__tick" :x="LEFT - 4" :y="midY + 3" text-anchor="end">0</text>
      <template v-if="!off">
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="TOP + 8" text-anchor="end">+{{ amplitude }}</text>
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="HEIGHT - BOTTOM" text-anchor="end">−{{ amplitude }}</text>
        <line
          v-if="delay > 0"
          class="ahx-lane__marker"
          :x1="xOf(delay)"
          :x2="xOf(delay)"
          :y1="TOP"
          :y2="HEIGHT - BOTTOM"
        />
      </template>
      <polyline class="ahx-lane__trace" data-testid="ahx-vibrato-trace" :points="points" />
      <text class="ahx-lane__tick" :x="LEFT" :y="HEIGHT - 2">0</text>
      <text class="ahx-lane__tick" :x="WIDTH" :y="HEIGHT - 2" text-anchor="end">{{ frames }} ticks</text>
      <text v-if="off" class="ahx-lane__off" :x="(LEFT + WIDTH) / 2" :y="midY - 8" text-anchor="middle">off</text>
    </svg>
    <p class="ahx-lane__caption" data-testid="ahx-vibrato-caption">{{ caption }}</p>
  </div>
</template>

<script setup lang="ts">
/**
 * The vibrato as a curve (editor plan E9): the pitch offset over the ticks of a
 * note, flat for the delay, then a wobble. Labelled in the engine's period units
 * (not cents). Depth 0 draws "off".
 */
import { computed } from 'vue';
import {
  ahxVibratoAmplitude,
  ahxVibratoWindow,
  simulateAhxVibrato,
} from 'src/audio/tracker/ahx-instrument-visuals';

interface Props {
  delay: number;
  speed: number;
  depth: number;
}

const props = defineProps<Props>();

const WIDTH = 320;
const HEIGHT = 110;
const LEFT = 34;
const TOP = 8;
const BOTTOM = 14;

const off = computed(() => props.depth === 0);
const frames = computed(() => ahxVibratoWindow(props.delay, props.speed));
const amplitude = computed(() => Math.max(ahxVibratoAmplitude(props.depth), 1));
const midY = computed(() => (TOP + HEIGHT - BOTTOM) / 2);

const xOf = (frame: number): number => LEFT + (frame / frames.value) * (WIDTH - LEFT);

const trace = computed(() => simulateAhxVibrato(props.delay, props.speed, props.depth, frames.value));
const points = computed(() => {
  const half = (HEIGHT - BOTTOM - TOP) / 2;
  return trace.value
    .map((offset, frame) => `${xOf(frame).toFixed(1)},${(midY.value - (offset / amplitude.value) * half).toFixed(1)}`)
    .join(' ');
});

const caption = computed(() => {
  if (off.value) return 'Vibrato is off (depth 0): the pitch stays steady. Raise the depth to make it wobble.';
  const still = props.speed === 0 ? ' Speed 0 holds the pitch still, so nothing wobbles.' : '';
  const wait = props.delay > 0 ? `steady for ${props.delay} ticks, then ` : '';
  return `The pitch is ${wait}wobbling up and down by up to ${amplitude.value} period units (the engine’s own pitch steps, not cents).${still}`;
});

const summary = computed(() => `Vibrato curve. ${caption.value}`);
</script>

<style scoped>
.ahx-lane {
  display: grid;
  gap: 4px;
  max-width: 460px;
}

.ahx-lane__svg {
  width: 100%;
  height: auto;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.ahx-lane__zero {
  stroke: rgba(255, 255, 255, 0.25);
  stroke-dasharray: 3 3;
}

.ahx-lane__marker {
  stroke: #f0b25e;
  stroke-dasharray: 2 3;
  opacity: 0.7;
}

.ahx-lane__trace {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.6;
}

.ahx-lane__tick {
  fill: currentColor;
  font-size: 9px;
  opacity: 0.6;
}

.ahx-lane__off {
  fill: currentColor;
  font-size: 12px;
  opacity: 0.6;
}

.ahx-lane__caption {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}
</style>

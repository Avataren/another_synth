<template>
  <div
    class="ahx-lane"
    :class="{ 'ahx-lane--off': state !== 'on' }"
    :data-testid="`ahx-sweep-lane-${kind}`"
    :data-state="state"
  >
    <svg
      class="ahx-lane__svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      :aria-label="summary"
    >
      <rect
        class="ahx-lane__band"
        :data-testid="`ahx-sweep-band-${kind}`"
        :x="LEFT"
        :y="bandTop"
        :width="WIDTH - LEFT"
        :height="Math.max(bandBottom - bandTop, 1)"
      />
      <template v-if="kind === 'filter'">
        <line class="ahx-lane__zero" :x1="LEFT" :x2="WIDTH" :y1="yOf(32)" :y2="yOf(32)" />
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="yOf(32) + 3" text-anchor="end">32</text>
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="yOf(63) + 8" text-anchor="end">63</text>
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="yOf(1)" text-anchor="end">1</text>
        <text class="ahx-lane__zone" :x="WIDTH - 4" :y="yOf(63) + 10" text-anchor="end">thin and bright</text>
        <text class="ahx-lane__zone" :x="WIDTH - 4" :y="yOf(1) - 3" text-anchor="end">soft and muffled</text>
        <text class="ahx-lane__zone" :x="LEFT + 4" :y="yOf(32) - 3">untouched</text>
      </template>
      <template v-else>
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="yOf(0.5) + 8" text-anchor="end">50%</text>
        <text class="ahx-lane__tick" :x="LEFT - 4" :y="yOf(0)" text-anchor="end">0%</text>
        <text class="ahx-lane__zone" :x="WIDTH - 4" :y="yOf(0.5) + 10" text-anchor="end">wide and hollow</text>
        <text class="ahx-lane__zone" :x="WIDTH - 4" :y="yOf(0) - 3" text-anchor="end">thin and nasal</text>
      </template>
      <polyline
        v-if="state === 'on'"
        class="ahx-lane__trace"
        :data-testid="`ahx-sweep-trace-${kind}`"
        :points="points"
      />
      <text class="ahx-lane__tick" :x="LEFT" :y="HEIGHT - 2">0</text>
      <text class="ahx-lane__tick" :x="WIDTH" :y="HEIGHT - 2" text-anchor="end">{{ frames }} ticks</text>
      <text
        v-if="state !== 'on'"
        class="ahx-lane__off"
        :data-testid="`ahx-sweep-off-${kind}`"
        :x="(LEFT + WIDTH) / 2"
        :y="HEIGHT / 2"
        text-anchor="middle"
        >sweep is off</text
      >
    </svg>

    <div v-if="kind === 'square'" class="ahx-lane__pulses" data-testid="ahx-sweep-pulses">
      <figure v-for="end in pulseEnds" :key="end.id" class="ahx-lane__pulse">
        <svg viewBox="0 0 96 32" class="ahx-lane__pulse-svg" aria-hidden="true">
          <path :d="end.path" :data-testid="`ahx-sweep-pulse-${end.id}`" />
        </svg>
        <figcaption>{{ end.label }} ({{ end.percent }}%)</figcaption>
      </figure>
    </div>

    <p class="ahx-lane__caption" :data-testid="`ahx-sweep-caption-${kind}`">{{ caption }}</p>
    <p v-if="state !== 'on'" class="ahx-lane__off-note" :data-testid="`ahx-sweep-why-${kind}`">
      {{ offReason }}
      <button
        v-if="state !== 'unavailable'"
        type="button"
        class="ahx-lane__enable"
        :disabled="!canEnable"
        :title="canEnable ? enableTitle : 'Row 0 of the PList has no free command slot for this.'"
        :data-testid="`ahx-sweep-enable-${kind}`"
        @click="emit('enable')"
      >
        {{ state === 'no-square-row' ? 'Use the square wave on row 0' : 'Turn on at row 0' }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
/**
 * A sweep as a picture (editor plan E8): where the filter position (brightness)
 * or the square wave's pulse width travels over the ticks of a note, the band
 * between its two limits, and an explicit "sweep is off" state (the limits and
 * speed do nothing until a PList command switches the sweep on).
 */
import { computed } from 'vue';
import type { AhxInstrument, AhxSongFormat } from '@another-synth/tracker-playback';
import {
  ahxFilterBounds,
  ahxShapePath,
  ahxSquareBounds,
  ahxSquareDuty,
  ahxSquareDutyRange,
  ahxSweepRate,
  ahxSweepSetup,
  ahxSweepState,
  ahxSweepWindow,
  canEnableAhxSweep,
  simulateFilterSweep,
  simulateSquareSweep,
  ahxWaveShape,
  type AhxSweepKind,
} from 'src/audio/tracker/ahx-instrument-visuals';

interface Props {
  kind: AhxSweepKind;
  instrument: AhxInstrument;
  format: AhxSongFormat;
  version: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (event: 'enable'): void }>();

const WIDTH = 320;
const HEIGHT = 120;
const LEFT = 34;
const TOP = 8;
const BOTTOM = 14;

const context = computed(() => ({ format: props.format, version: props.version }));
const setup = computed(() => ahxSweepSetup(props.instrument, props.kind, context.value));
const state = computed(() => ahxSweepState(setup.value, props.kind));
const canEnable = computed(() => canEnableAhxSweep(props.instrument, props.kind, context.value));

const bounds = computed(() =>
  props.kind === 'filter' ? ahxFilterBounds(props.instrument) : ahxSquareBounds(props.instrument),
);
const speed = computed(() =>
  props.kind === 'filter' ? props.instrument.filterSpeed : props.instrument.squareSpeed,
);
const frames = computed(() => ahxSweepWindow(props.kind, bounds.value, speed.value));

const dutyOf = (pos: number): number => ahxSquareDuty(pos, props.instrument.waveLength);

/** The value drawn on the y axis: filter position 1..63, or square pulse width 0..0.5. */
function yOf(value: number): number {
  const top = TOP;
  const height = HEIGHT - BOTTOM - TOP;
  return props.kind === 'filter'
    ? top + ((63 - value) / 62) * height
    : top + ((0.5 - value) / 0.5) * height;
}
const xOf = (frame: number): number => LEFT + (frame / frames.value) * (WIDTH - LEFT);

const bandValues = computed(() => {
  if (props.kind === 'filter') {
    const clip = (v: number): number => Math.max(1, Math.min(63, v));
    return [clip(bounds.value.lower), clip(bounds.value.upper)];
  }
  const { min, max } = ahxSquareDutyRange(props.instrument);
  return [min, max];
});
const bandTop = computed(() => yOf(Math.max(...bandValues.value)));
const bandBottom = computed(() => yOf(Math.min(...bandValues.value)));

const trace = computed(() => {
  const setupNow = setup.value;
  const sign = setupNow.sign;
  if (props.kind === 'filter') return simulateFilterSweep(props.instrument, frames.value, sign);
  return simulateSquareSweep(props.instrument, frames.value, setupNow.startPos ?? 0, sign).map(dutyOf);
});
const points = computed(() =>
  trace.value.map((v, frame) => `${xOf(frame).toFixed(1)},${yOf(v).toFixed(1)}`).join(' '),
);

/** The two ends of a square sweep as little pulse shapes. */
const pulseEnds = computed(() => {
  if (props.kind !== 'square') return [];
  return (['lower', 'upper'] as const).map((id) => {
    const pos = bounds.value[id];
    // Full resolution so the width reads clearly; the pulse width itself does not depend on the wave length.
    const samples = ahxWaveShape('square', 5, pos << Math.max(5 - Math.min(5, props.instrument.waveLength), 0)) ?? [];
    return {
      id,
      label: id === 'lower' ? 'At the lower limit' : 'At the upper limit',
      percent: Math.round(dutyOf(pos) * 100),
      path: ahxShapePath(samples, 96, 32),
    };
  });
});

const caption = computed(() => {
  const rate = ahxSweepRate(props.kind, speed.value);
  const pace =
    rate.steps > 1
      ? `${rate.steps} steps every tick`
      : rate.every === 1
        ? 'one step every tick'
        : `one step every ${rate.every} ticks`;
  const slow = `Speed ${speed.value} is a delay, so a bigger number is slower (${pace}).`;
  if (props.kind === 'filter') {
    const { lower, upper } = bounds.value;
    const range =
      lower === upper
        ? `The two limits are equal (${lower}), so there is nothing to bounce between and the brightness runs straight past them; set them apart.`
        : `The brightness sweeps between ${lower} and ${upper}: below 32 is soft and muffled, above 32 is thin and bright, 32 is untouched.`;
    return `${range} ${slow}`;
  }
  const { min, max } = ahxSquareDutyRange(props.instrument);
  const thin = Math.round(min * 100);
  const fat = Math.round(max * 100);
  const range =
    bounds.value.lower === bounds.value.upper
      ? `The two widths are equal (${thin}%), so there is nothing to bounce between and the pulse width runs straight past them; set them apart.`
      : `The square wave\u2019s pulse width sweeps between ${thin}% (thin and nasal) and ${fat}% (fatter and hollower; 50% is the fullest).`;
  return `${range} ${slow}`;
});

const offReason = computed(() => {
  switch (state.value) {
    case 'unavailable':
      return 'This AHX version-0 file cannot sweep the brightness (the format ignores that switch), so the limits and speed do nothing.';
    case 'no-square-row':
      return 'The sweep is switched on, but no step of the PList uses the square wave, so nothing moves.';
    default:
      return props.kind === 'filter'
        ? 'Inactive: nothing in the PList switches the brightness sweep on, so the limits and speed above do nothing yet.'
        : 'Inactive: nothing in the PList switches the pulse-width sweep on, so the limits and speed above do nothing yet.';
  }
});

const enableTitle = computed(() =>
  props.kind === 'filter'
    ? 'Adds a command to the first PList step that starts the brightness sweep.'
    : 'Adds a command to the first PList step that starts the pulse-width sweep, and picks the square wave there if no step does.',
);

const summary = computed(
  () => `${props.kind === 'filter' ? 'Brightness' : 'Pulse width'} sweep. ${state.value === 'on' ? '' : offReason.value} ${caption.value}`,
);
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

.ahx-lane__band {
  fill: var(--tracker-accent-secondary, #5ec2e8);
  opacity: 0.18;
}

.ahx-lane--off .ahx-lane__band {
  fill: currentColor;
  opacity: 0.08;
}

.ahx-lane__zero {
  stroke: rgba(255, 255, 255, 0.3);
  stroke-dasharray: 3 3;
}

.ahx-lane__trace {
  fill: none;
  stroke: var(--tracker-accent-primary, #f0b25e);
  stroke-width: 1.6;
}

.ahx-lane__tick,
.ahx-lane__zone {
  fill: currentColor;
  font-size: 9px;
  opacity: 0.6;
}

.ahx-lane__zone {
  opacity: 0.45;
}

.ahx-lane__off {
  fill: currentColor;
  font-size: 13px;
  opacity: 0.7;
}

.ahx-lane__pulses {
  display: flex;
  gap: 12px;
}

.ahx-lane__pulse {
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.85;
}

.ahx-lane__pulse-svg {
  display: block;
  width: 96px;
  height: 32px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 3px;
}

.ahx-lane__pulse-svg path {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
}

.ahx-lane__caption,
.ahx-lane__off-note {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.75;
}

.ahx-lane__off-note {
  color: #f0b25e;
  opacity: 1;
}

.ahx-lane__enable {
  margin-left: 8px;
  padding: 2px 10px;
  color: inherit;
  font: inherit;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 3px;
}

.ahx-lane__enable:disabled {
  cursor: default;
  opacity: 0.4;
}
</style>

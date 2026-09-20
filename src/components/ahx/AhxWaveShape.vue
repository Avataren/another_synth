<template>
  <div class="ahx-wave-shape" data-testid="ahx-wave-shape" :data-samples="sampleCount" :data-kind="kind">
    <svg
      v-if="samples"
      class="ahx-wave-shape__svg"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      :aria-label="`${kind} wave, ${sampleCount} samples in one cycle`"
    >
      <line class="ahx-wave-shape__mid" x1="0" :x2="WIDTH" :y1="HEIGHT / 2" :y2="HEIGHT / 2" />
      <rect
        v-for="(bar, i) in bars"
        :key="i"
        class="ahx-wave-bar"
        :x="bar.x"
        :y="bar.y"
        :width="bar.width"
        :height="bar.height"
      />
    </svg>
    <svg
      v-else
      class="ahx-wave-shape__svg ahx-wave-shape__svg--noise"
      :viewBox="`0 0 ${WIDTH} ${HEIGHT}`"
      role="img"
      aria-label="noise: a new random burst every tick"
    >
      <line class="ahx-wave-shape__mid" x1="0" :x2="WIDTH" :y1="HEIGHT / 2" :y2="HEIGHT / 2" />
      <path class="ahx-wave-shape__noise" :d="NOISE_PATH" />
    </svg>
    <p class="ahx-wave-shape__caption" data-testid="ahx-wave-shape-caption">
      <template v-if="samples">
        One cycle of the tone, drawn as its {{ sampleCount }} steps: fewer steps sound rougher, more sound smoother.
      </template>
      <template v-else>
        Noise has no fixed shape: the engine picks a new random burst every tick.
      </template>
    </p>
    <p v-if="kind === 'square'" class="ahx-wave-shape__caption" data-testid="ahx-wave-shape-duty">
      Pulse width shown: {{ dutyPercent }}% of the cycle is high (thinner sounds more nasal, 50% is the fullest).
    </p>
    <span
      v-if="filtered"
      class="ahx-chip"
      data-testid="ahx-wave-prefilter"
      title="A filter changes this tone as it plays, making it softer or thinner; the drawing shows the tone before that."
      >before filtering</span
    >
  </div>
</template>

<script setup lang="ts">
/**
 * The exact shape of one cycle of an instrument's tone as stepped bars (editor
 * plan E5): `4 << waveLength` samples, from ports of the engine's own table
 * generators (`ahx-instrument-visuals.ts`). Noise has no shape, so it is a glyph.
 */
import { computed } from 'vue';
import type { AhxWaveformKind } from 'src/audio/tracker/ahx-instrument-display';
import { ahxSquareDuty, ahxWaveShape } from 'src/audio/tracker/ahx-instrument-visuals';

interface Props {
  kind: AhxWaveformKind;
  waveLength: number;
  /** The square's pulse-width position (engine units); only a square uses it. */
  squarePos?: number;
  /** A filter is in play, so the true sound differs from the drawing. */
  filtered?: boolean;
}

const props = withDefaults(defineProps<Props>(), { squarePos: 0, filtered: false });

const WIDTH = 256;
const HEIGHT = 96;
const NOISE_PATH =
  'M0 48 L12 20 L20 74 L34 32 L46 82 L58 10 L70 66 L84 24 L96 78 L110 30 L122 70 L136 14 L148 60 L162 36 L176 80 L190 22 L204 72 L218 28 L232 66 L256 48';

const samples = computed(() => ahxWaveShape(props.kind, props.waveLength, props.squarePos));
const sampleCount = computed(() => samples.value?.length ?? 0);
const dutyPercent = computed(() => Math.round(ahxSquareDuty(props.squarePos, props.waveLength) * 100));

/** One bar per sample, from the centre line to the sample's value (-128..127). */
const bars = computed(() => {
  const list = samples.value ?? [];
  const width = WIDTH / Math.max(list.length, 1);
  return list.map((value, i) => {
    const h = (Math.abs(value) / 128) * (HEIGHT / 2 - 2);
    return {
      x: i * width,
      y: value >= 0 ? HEIGHT / 2 - h : HEIGHT / 2,
      width: Math.max(width - (list.length > 64 ? 0.2 : 1), 0.5),
      height: Math.max(h, 0.5),
    };
  });
});
</script>

<style scoped>
.ahx-wave-shape {
  display: grid;
  gap: 4px;
  max-width: 420px;
}

.ahx-wave-shape__svg {
  width: 100%;
  height: auto;
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.ahx-wave-shape__mid {
  stroke: rgba(255, 255, 255, 0.25);
  stroke-dasharray: 3 3;
}

.ahx-wave-bar {
  fill: var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-wave-shape__noise {
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
}

.ahx-wave-shape__caption {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}

.ahx-chip {
  justify-self: start;
  padding: 1px 8px;
  font-size: 0.75rem;
  color: #f2d08a;
  border: 1px solid currentColor;
  border-radius: 10px;
}
</style>

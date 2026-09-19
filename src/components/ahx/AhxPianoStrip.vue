<template>
  <svg
    class="ahx-piano"
    :class="{ 'ahx-piano--disabled': disabled }"
    :viewBox="`0 0 ${width} ${HEIGHT}`"
    :width="width * SCALE"
    :height="HEIGHT * SCALE"
    role="group"
    aria-label="On-screen piano"
    data-testid="ahx-piano"
    @contextmenu.prevent
  >
    <rect
      v-for="key in whiteKeys"
      :key="key.midi"
      class="ahx-piano__white"
      :class="{ 'ahx-piano__key--held': held.has(key.midi) }"
      :x="key.x"
      y="0"
      :width="WHITE_W"
      :height="HEIGHT"
      rx="1.5"
      role="button"
      :aria-label="key.name"
      :aria-disabled="disabled === true"
      :data-testid="`ahx-piano-${key.midi}`"
      @pointerdown.prevent="down(key.midi)"
      @pointerup="up(key.midi)"
      @pointerleave="up(key.midi)"
      @pointercancel="up(key.midi)"
    >
      <title>{{ key.name }}</title>
    </rect>
    <rect
      v-for="key in blackKeys"
      :key="key.midi"
      class="ahx-piano__black"
      :class="{ 'ahx-piano__key--held': held.has(key.midi) }"
      :x="key.x"
      y="0"
      :width="BLACK_W"
      :height="BLACK_H"
      rx="1"
      role="button"
      :aria-label="key.name"
      :aria-disabled="disabled === true"
      :data-testid="`ahx-piano-${key.midi}`"
      @pointerdown.prevent="down(key.midi)"
      @pointerup="up(key.midi)"
      @pointerleave="up(key.midi)"
      @pointercancel="up(key.midi)"
    >
      <title>{{ key.name }}</title>
    </rect>
    <text
      v-for="key in cLabels"
      :key="`c${key.midi}`"
      class="ahx-piano__label"
      :x="key.x + WHITE_W / 2"
      :y="HEIGHT - 3"
      text-anchor="middle"
    >
      {{ key.name }}
    </text>
  </svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

interface Props {
  /** The lowest key: a C, as MIDI. */
  start: number;
  octaves?: number;
  /** Keys drawn as down. */
  held: ReadonlySet<number>;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), { octaves: 2, disabled: false });
const emit = defineEmits<{
  (e: 'down', midi: number): void;
  (e: 'up', midi: number): void;
}>();

const WHITE_W = 12;
const BLACK_W = 8;
const HEIGHT = 40;
const BLACK_H = 24;
/** On-screen size per viewBox unit: a fingertip-sized key without taking the bar's height. */
const SCALE = 1.4;

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** Where each pitch class sits, in white-key widths from its octave's C (a black key sits on the seam). */
const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const BLACK_SEAM: Record<number, number> = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };

const noteName = (midi: number): string => `${NAMES[midi % 12]}-${Math.floor(midi / 12) - 1}`;
const width = computed(() => props.octaves * 7 * WHITE_W);

const whiteKeys = computed(() =>
  Array.from({ length: props.octaves * 7 }, (_, i) => {
    const midi = props.start + Math.floor(i / 7) * 12 + WHITE_PCS[i % 7]!;
    return { midi, x: i * WHITE_W, name: noteName(midi) };
  }).filter((key) => key.midi <= 127),
);

const blackKeys = computed(() => {
  const keys: { midi: number; x: number; name: string }[] = [];
  for (let octave = 0; octave < props.octaves; octave++) {
    for (const [pc, seam] of Object.entries(BLACK_SEAM)) {
      const midi = props.start + octave * 12 + Number(pc);
      if (midi > 127) continue;
      keys.push({
        midi,
        x: (octave * 7 + seam) * WHITE_W - BLACK_W / 2,
        name: noteName(midi),
      });
    }
  }
  return keys;
});

const cLabels = computed(() => whiteKeys.value.filter((key) => key.midi % 12 === 0));

function down(midi: number): void {
  if (!props.disabled) emit('down', midi);
}
function up(midi: number): void {
  emit('up', midi);
}
</script>

<style scoped>
.ahx-piano {
  flex: none;
  touch-action: none;
  user-select: none;
}

.ahx-piano__white {
  fill: #e8f3ff;
  stroke: #0b111a;
  stroke-width: 0.6;
  cursor: pointer;
}

.ahx-piano__black {
  fill: #101820;
  stroke: #0b111a;
  stroke-width: 0.6;
  cursor: pointer;
}

.ahx-piano__key--held {
  fill: var(--tracker-accent-primary, #f0b25e);
}

.ahx-piano__label {
  font-size: 5px;
  fill: #0b111a;
  pointer-events: none;
}

.ahx-piano--disabled {
  opacity: 0.4;
}

.ahx-piano--disabled rect {
  cursor: not-allowed;
}
</style>

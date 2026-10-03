<template>
  <div class="xm-keymap" data-testid="xm-keymap">
    <div class="xm-keymap__row" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <div
        v-for="note in 96"
        :key="note"
        class="xm-keymap__key"
        :class="{ 'xm-keymap__key--black': isBlack(note - 1), 'xm-keymap__key--current': keymap[note - 1] === selected }"
        :style="{ '--xm-sample-hue': hue(keymap[note - 1] ?? 0) }"
        :data-note="note - 1"
        :title="`${noteName(note - 1)} → sample ${(keymap[note - 1] ?? 0) + 1}`"
      />
    </div>
    <div class="xm-keymap__octaves" aria-hidden="true">
      <span v-for="o in 8" :key="o">C-{{ o - 1 }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue';

interface Props {
  keymap: number[];
  /** The sample a drag paints. */
  selected: number;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'paint', from: number, to: number): void;
}>();

const NAMES = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'];
const noteName = (n: number): string => `${NAMES[n % 12]}${Math.floor(n / 12)}`;
const isBlack = (n: number): boolean => [1, 3, 6, 8, 10].includes(n % 12);
/** Each sample gets its own colour, spread round the wheel. */
const hue = (sample: number): number => (sample * 47 + 200) % 360;

let anchor: number | null = null;

function noteAt(event: PointerEvent): number | null {
  const el = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  if (!el) return null;
  const frac = (event.clientX - el.left) / Math.max(1, el.width);
  return Math.max(0, Math.min(95, Math.floor(frac * 96)));
}

function onDown(event: PointerEvent): void {
  const note = noteAt(event);
  if (note === null) return;
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  anchor = note;
  emit('paint', note, note);
}

function onMove(event: PointerEvent): void {
  if (anchor === null) return;
  const note = noteAt(event);
  if (note !== null) emit('paint', anchor, note);
}

function onUp(event: PointerEvent): void {
  anchor = null;
  (event.currentTarget as HTMLElement | null)?.releasePointerCapture?.(event.pointerId);
}

onBeforeUnmount(() => {
  anchor = null;
  void props.selected;
});
</script>

<style scoped>
.xm-keymap__row {
  display: grid;
  grid-template-columns: repeat(96, minmax(0, 1fr));
  height: 36px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  overflow: hidden;
  cursor: crosshair;
  touch-action: none;
}

.xm-keymap__key {
  background: hsl(var(--xm-sample-hue) 45% 38%);
  border-right: 1px solid rgba(0, 0, 0, 0.25);
  opacity: 0.75;
}

.xm-keymap__key--black {
  background: hsl(var(--xm-sample-hue) 45% 26%);
}

.xm-keymap__key--current {
  opacity: 1;
}

.xm-keymap__octaves {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  font-size: 0.75rem;
  opacity: 0.55;
  font-family: var(--tracker-font, monospace);
}
</style>

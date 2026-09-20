<template>
  <div class="ahx-strip" data-testid="ahx-plist-strip">
    <p class="ahx-strip__intro" data-testid="ahx-plist-strip-caption">
      The PList is a little score that plays while a note sounds, one step after another, changing the tone,
      pitch and effects. Each box is one step; click one to find it in the table below.
    </p>
    <div
      class="ahx-strip__row"
      role="listbox"
      aria-label="PList steps"
      aria-orientation="horizontal"
      @keydown="onKeydown"
    >
      <button
        v-for="chip in chips"
        :key="chip.index"
        :ref="(el) => setRef(chip.index, el)"
        type="button"
        role="option"
        class="ahx-chip"
        :class="{ 'ahx-chip--selected': chip.index === selected }"
        :aria-selected="chip.index === selected"
        :tabindex="chip.index === focusIndex ? 0 : -1"
        :title="chip.summary"
        :data-testid="`ahx-strip-chip-${chip.index}`"
        :data-selected="chip.index === selected ? 'true' : 'false'"
        @click="emit('select', chip.index)"
      >
        <span class="ahx-chip__head">
          <span class="ahx-chip__row">{{ chip.hex }}</span>
          <svg class="ahx-chip__glyph" viewBox="0 0 32 16" aria-hidden="true">
            <path :d="glyphFor(chip.wave)" />
          </svg>
          <span class="ahx-chip__wave">{{ chip.waveText }}</span>
        </span>
        <span class="ahx-chip__pitch" :title="chip.pitchTitle">{{ chip.pitchText }}</span>
        <span v-if="chip.fx.length === 0" class="ahx-chip__none">no effect</span>
        <span
          v-for="(fx, i) in chip.fx"
          :key="i"
          class="ahx-chip__fx"
          :class="`ahx-chip__fx--${fx.kind}`"
          :data-testid="`ahx-strip-fx-${chip.index}-${i}`"
        >
          <span class="ahx-chip__fxname">{{ fx.name }}</span>
          <span class="ahx-chip__code">{{ fx.code }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * The PList as a strip of named steps (editor plan E6, read and select first):
 * one box per PList entry with its tone, pitch and its commands in plain words
 * (the raw code is small, secondary text). Selecting a box highlights the same
 * row of the table; the inspector that edits it is a later task. One tab stop:
 * the arrow keys, Home and End move the selection.
 */
import { computed, nextTick, type ComponentPublicInstance } from 'vue';
import type { AhxPListEntry } from '@another-synth/tracker-playback';
import type { AhxWaveformKind } from 'src/audio/tracker/ahx-instrument-display';
import { ahxPListChips } from 'src/audio/tracker/ahx-plain-language';

interface Props {
  entries: readonly AhxPListEntry[];
  /** The selected row, or `null` for none. */
  selected: number | null;
  glyphs: Readonly<Record<AhxWaveformKind | 'unknown', string>>;
}

const props = defineProps<Props>();
const emit = defineEmits<{ (event: 'select', row: number): void }>();

const chips = computed(() => ahxPListChips(props.entries));
/** The one box in the tab order: the selection, else the first. */
const focusIndex = computed(() =>
  props.selected !== null && props.selected < props.entries.length ? props.selected : 0,
);

const glyphFor = (wave: AhxWaveformKind | 'keep' | 'unknown'): string =>
  wave === 'keep' ? 'M0 8 L32 8' : props.glyphs[wave];

const refs = new Map<number, HTMLElement>();
function setRef(index: number, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) refs.set(index, el);
  else refs.delete(index);
}

function onKeydown(event: KeyboardEvent): void {
  const count = props.entries.length;
  if (count === 0) return;
  const current = focusIndex.value;
  let next: number | null = null;
  if (event.key === 'ArrowRight') next = Math.min(count - 1, current + 1);
  else if (event.key === 'ArrowLeft') next = Math.max(0, current - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  if (next === null) return;
  // Only the keys the strip uses are taken; everything else (the play keys, Escape) passes through.
  event.preventDefault();
  event.stopPropagation();
  emit('select', next);
  void nextTick(() => refs.get(next!)?.focus());
}
</script>

<style scoped>
.ahx-strip {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
}

.ahx-strip__intro {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.7;
}

.ahx-strip__row {
  display: flex;
  gap: 6px;
  padding-bottom: 6px;
  overflow-x: auto;
}

.ahx-chip {
  display: inline-flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 104px;
  padding: 5px 8px;
  color: inherit;
  font: inherit;
  font-size: 0.8rem;
  text-align: left;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 5px;
}

.ahx-chip--selected {
  background: var(--tracker-active-bg, #14283d);
  border-color: var(--tracker-accent-primary, #f0b25e);
  outline: 2px solid var(--tracker-accent-primary, #f0b25e);
}

.ahx-chip:focus-visible {
  outline: 2px solid var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-chip__head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.ahx-chip__row {
  font-family: var(--tracker-font, monospace);
  opacity: 0.6;
}

.ahx-chip__glyph {
  width: 26px;
  height: 13px;
  fill: none;
  stroke: var(--tracker-accent-secondary, #5ec2e8);
  stroke-width: 1.5;
}

.ahx-chip__pitch {
  font-family: var(--tracker-font, monospace);
}

.ahx-chip__none {
  opacity: 0.4;
}

.ahx-chip__fx {
  display: flex;
  align-items: baseline;
  gap: 5px;
  color: var(--tracker-accent-primary, #f0b25e);
}

.ahx-chip__fx--unused {
  opacity: 0.5;
}

.ahx-chip__code {
  font-family: var(--tracker-font, monospace);
  font-size: 0.65rem;
  opacity: 0.55;
}
</style>

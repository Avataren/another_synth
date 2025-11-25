<template>
  <div
    class="tracker-entry"
    :class="entryClasses"
    :style="{ '--entry-accent': accentColor || 'var(--tracker-accent)' }"
    role="button"
    tabindex="-1"
    @click="onSelectRow"
    @mousedown.left="onMouseDownRow"
    @mouseenter="onMouseEnterRow"
  >
    <span
      class="cell note"
      :class="{ 'cell-active': isActiveCell(0) }"
      @click.stop="onSelectCell(0)"
      @mousedown.stop
    >
      {{ cells.note.display }}
    </span>
    <span
      class="cell instrument"
      :class="{ 'cell-active': isActiveCell(1) }"
      @click.stop="onSelectCell(1)"
      @mousedown.stop
    >
      {{ cells.instrument.display }}
    </span>
    <span
      class="cell volume volume-high"
      :class="{ 'cell-active': isActiveCell(2) }"
      @click.stop="onSelectCell(2)"
      @mousedown.stop
    >
      {{ cells.volumeHi.display }}
    </span>
    <span
      class="cell volume volume-low"
      :class="{ 'cell-active': isActiveCell(3) }"
      @click.stop="onSelectCell(3)"
      @mousedown.stop
    >
      {{ cells.volumeLo.display }}
    </span>
    <span class="cell effect" :class="{ 'cell-active': isActiveCell(4) }">
      <span class="macro-digits">
        <span
          v-for="(digit, idx) in cells.macroDigits"
          :key="idx"
          class="macro-digit"
          :class="{ active: isActiveCell(4) && activeMacroNibble === idx }"
          @click.stop="onSelectCell(4, idx)"
          @mousedown.stop
        >
          {{ digit }}
        </span>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { TrackerEntryData } from './tracker-types';

interface Props {
  entry?: TrackerEntryData | undefined;
  rowIndex: number;
  active: boolean;
  selected: boolean;
  accentColor?: string | undefined;
  trackIndex: number;
  activeTrack: number;
  activeColumn: number;
  activeMacroNibble: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'selectCell', payload: { row: number; column: number; trackIndex: number; macroNibble?: number | undefined }): void;
  (event: 'startSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'hoverSelection', payload: { row: number; trackIndex: number }): void;
}>();

const isActiveTrack = computed(() => props.trackIndex === props.activeTrack);

const entryClasses = computed(() => {
  const classes: Record<string, boolean> = {
    active: props.active,
    filled: !!props.entry,
    focused: isActiveTrack.value && props.active,
    selected: props.selected
  };

  const rowIndex = props.rowIndex;

  if (!classes.active && !classes.selected) {
    if (rowIndex % 16 === 0) {
      classes['row-bar'] = true;
    } else if (rowIndex % 4 === 0) {
      classes['row-beat'] = true;
    } else if (rowIndex % 2 === 0) {
      classes['row-sub'] = true;
    }
  }

  return classes;
});

const cells = computed(() => {
  const volume = props.entry?.volume ?? '..';
  const volPadded = (volume + '..').slice(0, 2);
  const macro = props.entry?.macro ?? '...';
  const macroPadded = (macro + '...').slice(0, 3);
  const noteDisplay = (() => {
    if (!props.entry?.note) return '---';
    const normalized = props.entry.note.trim().toUpperCase();
    const isRelease =
      normalized === '--' || normalized === '---' || normalized === '###';
    return isRelease ? '###' : props.entry.note;
  })();
  const macroDigits = macroPadded.split('');
  return {
    note: { display: noteDisplay, className: 'note' },
    instrument: { display: props.entry?.instrument ?? '..', className: 'instrument' },
    volumeHi: { display: volPadded[0] ?? '.', className: 'volume volume-high' },
    volumeLo: { display: volPadded[1] ?? '.', className: 'volume volume-low' },
    macroDigits
  };
});

function onSelectRow() {
  emit('selectCell', { row: props.rowIndex, column: 0, trackIndex: props.trackIndex });
}

function onSelectCell(column: number, macroNibble?: number) {
  emit('selectCell', { row: props.rowIndex, column, trackIndex: props.trackIndex, macroNibble });
}

function onMouseDownRow() {
  emit('startSelection', { row: props.rowIndex, trackIndex: props.trackIndex });
}

function onMouseEnterRow() {
  emit('hoverSelection', { row: props.rowIndex, trackIndex: props.trackIndex });
}

function isActiveCell(column: number) {
  return isActiveTrack.value && props.active && props.activeColumn === column;
}
</script>

<style scoped>
.tracker-entry {
  --entry-accent: var(--tracker-accent, var(--tracker-accent-primary, rgb(77, 242, 197)));
  height: var(--tracker-row-height);
  width: 100%;
  display: grid;
  grid-template-columns: 1.6fr 1fr 0.35fr 0.35fr 1.4fr;
  align-items: center;
  padding: 6px 10px;
  border: 1px solid var(--tracker-border-default, rgba(255, 255, 255, 0.05));
  border-radius: 8px;
  background: var(--tracker-entry-base, rgba(13, 18, 29, 0.85));
  color: var(--tracker-default-text, #d8e7ff);
  font-family: var(--font-tracker);
  font-size: 12px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, transform 80ms ease;
}

.tracker-entry:hover {
  border-color: var(--tracker-border-hover, rgba(255, 255, 255, 0.12));
}

.tracker-entry.filled {
  background: linear-gradient(
    90deg,
    var(--tracker-entry-filled, rgba(21, 31, 48, 0.95)),
    var(--tracker-entry-filled-alt, rgba(17, 24, 38, 0.95))
  );
}

.tracker-entry.active {
  border-color: var(--tracker-active-border, var(--entry-accent));
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
  transform: none;
}

.tracker-entry.selected:not(.active) {
  border-color: var(--tracker-selected-border, rgba(77, 242, 197, 0.9));
  background: var(--tracker-selected-bg, rgba(77, 242, 197, 0.12));
}

.tracker-entry.row-sub:not(.active):not(.selected) {
  background: var(--tracker-entry-row-sub, rgba(13, 18, 29, 0.9));
}

.tracker-entry.row-beat:not(.active):not(.selected) {
  background: var(--tracker-entry-row-beat, rgba(18, 24, 37, 0.95));
  border-color: var(--tracker-border-beat, rgba(255, 255, 255, 0.08));
}

.tracker-entry.row-bar:not(.active):not(.selected) {
  background: var(--tracker-entry-row-bar, rgba(20, 28, 44, 0.98));
  border-color: var(--tracker-border-bar, rgba(77, 242, 197, 0.35));
}

.tracker-entry:active {
  transform: translateY(0);
}

.tracker-entry:focus,
.tracker-entry:focus-visible {
  outline: none;
}

.cell {
  text-align: left;
  white-space: nowrap;
}

.cell-active {
  color: var(--tracker-cell-active-text, #0c1624);
  font-weight: 800;
  background: var(
    --tracker-cell-active-bg,
    linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9))
  );
  border-radius: 6px;
  padding: 2px 6px;
}

.note {
  color: var(--tracker-note-text, #ffffff);
  font-weight: 700;
}

.instrument {
  color: var(--tracker-instrument-text, rgba(255, 255, 255, 0.82));
}

.volume {
  color: var(--tracker-volume-text, #85b7ff);
}

.volume-low {
  justify-self: start;
}

.effect {
  color: var(--tracker-effect-text, #8ef5c5);
}

.macro-digits {
  display: inline-flex;
  gap: 2px;
}

.macro-digit {
  padding: 2px 3px;
  border-radius: 4px;
}

.macro-digit.active {
  color: var(--tracker-cell-active-text, #0c1624);
  font-weight: 800;
  background: var(
    --tracker-cell-active-bg,
    linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9))
  );
}
</style>

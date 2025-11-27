<template>
  <div
    class="tracker-entry"
    :class="entryClasses"
    :style="{ '--entry-accent': accentColor || 'var(--tracker-accent)' }"
    role="button"
    tabindex="-1"
    @click="handleClick"
    @mousedown.left="onMouseDownRow"
    @mouseenter="onMouseEnterRow"
  >
    <span
      class="cell note"
      :class="{ 'cell-active': activeCells[0] }"
      data-cell="0"
    >
      {{ cells.note.display }}
    </span>
    <span
      class="cell instrument"
      :class="{ 'cell-active': activeCells[1] }"
      data-cell="1"
    >
      {{ cells.instrument.display }}
    </span>
    <span
      class="cell volume volume-high"
      :class="{ 'cell-active': activeCells[2] }"
      data-cell="2"
    >
      {{ cells.volumeHi.display }}
    </span>
    <span
      class="cell volume volume-low"
      :class="{ 'cell-active': activeCells[3] }"
      data-cell="3"
    >
      {{ cells.volumeLo.display }}
    </span>
    <span class="cell effect" :class="{ 'cell-active': activeCells[4] }" data-cell="4">
      <span class="macro-digits">
        <span
          v-for="(digit, idx) in cells.macroDigits"
          :key="idx"
          class="macro-digit"
          :class="{ active: activeCells[4] && activeMacroNibble === idx }"
          :data-macro="idx"
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

// Cache isActiveTrack check - only recompute when trackIndex or activeTrack changes
const isActiveTrack = computed(() => props.trackIndex === props.activeTrack);

// Pre-compute row type based on index - this is stable and doesn't change
const rowType = computed(() => {
  const idx = props.rowIndex;
  if (idx % 16 === 0) return 'bar';
  if (idx % 4 === 0) return 'beat';
  if (idx % 2 === 0) return 'sub';
  return 'normal';
});

// Simplified class binding using pre-computed rowType
const entryClasses = computed(() => ({
  active: props.active,
  filled: !!props.entry,
  focused: isActiveTrack.value && props.active,
  selected: props.selected,
  'row-bar': !props.active && !props.selected && rowType.value === 'bar',
  'row-beat': !props.active && !props.selected && rowType.value === 'beat',
  'row-sub': !props.active && !props.selected && rowType.value === 'sub'
}));

// Default cells for empty entries - reused across empty rows (frozen to prevent reactivity overhead)
const DEFAULT_CELLS = Object.freeze({
  note: Object.freeze({ display: '---', className: 'note' }),
  instrument: Object.freeze({ display: '..', className: 'instrument' }),
  volumeHi: Object.freeze({ display: '.', className: 'volume volume-high' }),
  volumeLo: Object.freeze({ display: '.', className: 'volume volume-low' }),
  macroDigits: Object.freeze(['.', '.', '.'])
});

// Process cells only when entry exists - optimized to avoid unnecessary string operations
function processCells(entry: TrackerEntryData) {
  const volume = entry.volume ?? '..';
  const volPadded = volume.length >= 2 ? volume : (volume + '..').slice(0, 2);
  const macro = entry.macro ?? '...';
  const macroPadded = macro.length >= 3 ? macro : (macro + '...').slice(0, 3);

  let noteDisplay = '---';
  if (entry.note) {
    const normalized = entry.note.trim().toUpperCase();
    const isRelease = normalized === '--' || normalized === '---' || normalized === '###';
    noteDisplay = isRelease ? '###' : entry.note;
  }

  return {
    note: { display: noteDisplay, className: 'note' },
    instrument: { display: entry.instrument ?? '..', className: 'instrument' },
    volumeHi: { display: volPadded[0] ?? '.', className: 'volume volume-high' },
    volumeLo: { display: volPadded[1] ?? '.', className: 'volume volume-low' },
    macroDigits: [macroPadded[0] ?? '.', macroPadded[1] ?? '.', macroPadded[2] ?? '.']
  };
}

const cells = computed(() => {
  if (!props.entry) return DEFAULT_CELLS;
  return processCells(props.entry);
});

// Pre-compute active cell states to avoid repeated function calls in template
const activeCells = computed(() => {
  if (!isActiveTrack.value || !props.active) {
    return [false, false, false, false, false];
  }
  const col = props.activeColumn;
  return [col === 0, col === 1, col === 2, col === 3, col === 4];
});

// Event delegation handler - single click handler for all cells
function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement;

  // Check for macro digit click first (nested inside effect cell)
  const macroAttr = target.dataset.macro;
  if (macroAttr !== undefined) {
    const macroNibble = parseInt(macroAttr, 10);
    emit('selectCell', { row: props.rowIndex, column: 4, trackIndex: props.trackIndex, macroNibble });
    return;
  }

  // Check for cell click
  const cellAttr = target.dataset.cell ?? target.closest('[data-cell]')?.getAttribute('data-cell');
  if (cellAttr !== undefined && cellAttr !== null) {
    const column = parseInt(cellAttr, 10);
    emit('selectCell', { row: props.rowIndex, column, trackIndex: props.trackIndex });
    return;
  }

  // Default: select the row (column 0)
  emit('selectCell', { row: props.rowIndex, column: 0, trackIndex: props.trackIndex });
}

function onMouseDownRow() {
  emit('startSelection', { row: props.rowIndex, trackIndex: props.trackIndex });
}

function onMouseEnterRow() {
  emit('hoverSelection', { row: props.rowIndex, trackIndex: props.trackIndex });
}
</script>

<style scoped>
.tracker-entry {
  --entry-accent: var(--tracker-accent, var(--tracker-accent-primary, rgb(77, 242, 197)));
  height: 30px;
  min-height: 30px;
  max-height: 30px;
  width: 100%;
  min-width: 156px;
  display: grid;
  grid-template-columns: 1.6fr 1fr 0.35fr 0.35fr 1.8fr;
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
  /* Removed transitions for better performance during rapid updates */
  contain: layout style paint;
  will-change: auto;
  /* Prevent layout shifts */
  box-sizing: border-box;
}

.tracker-entry:hover {
  border-color: var(--tracker-border-hover, rgba(255, 255, 255, 0.12));
}

.tracker-entry.filled {
  background: var(--tracker-entry-filled, rgba(21, 31, 48, 0.95));
}

.tracker-entry.active {
  border-color: var(--tracker-active-border, var(--entry-accent));
  background: var(--tracker-active-bg, rgba(77, 242, 197, 0.08));
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

.tracker-entry:focus,
.tracker-entry:focus-visible {
  outline: none;
}

.cell {
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  min-width: 0;
}

.cell-active {
  color: inherit;
  font-weight: 800;
  background: rgba(77, 242, 197, 0.12);
  border-radius: 6px;
  padding: 2px 6px;
}

.effect.cell-active {
  /* Keep selection visible but let the text stay legible */
  background: rgba(77, 242, 197, 0.12);
  color: var(--tracker-effect-text, #8ef5c5);
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
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 2px 3px;
  border-radius: 4px;
  min-width: 0.9em;
  font-family: var(--font-tracker), monospace;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  font-weight: 700;
}

.macro-digit.active {
  color: var(--tracker-effect-text, #8ef5c5);
  font-weight: 700;
  background: rgba(77, 242, 197, 0.12);
}
</style>

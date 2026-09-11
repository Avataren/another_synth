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
    <span
      class="cell effect"
      :class="{
        'cell-active': activeCells[4],
        'interpolated-linear': interpolationType === 'linear',
        'interpolated-exponential': interpolationType === 'exponential'
      }"
      data-cell="4"
    >
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
    <span
      v-if="showExtraEffectColumn"
      class="cell effect extra-effect"
      :class="{ 'cell-active': activeCells[5] }"
      data-cell="5"
    >
      <span class="macro-digits">
        <span
          v-for="(digit, idx) in cells.macro2Digits"
          :key="idx"
          class="macro-digit"
          :class="{ active: activeCells[5] && activeMacroNibble === idx }"
          :data-macro="idx"
        >
          {{ digit }}
        </span>
      </span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import type { TrackerEntryData } from './tracker-types';
import { formatEntryCells } from './pattern-canvas/format-entry-cells';
import {
  TRACKER_PLAYBACK_ROW,
  TRACKER_SLOT_VISIBLE,
  type TrackerBufferSlot,
} from './use-tracker-playback-row';

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
  interpolationType?: 'linear' | 'exponential' | undefined;
  showExtraEffectColumn: boolean;
  /**
   * The playback buffer slot this entry's track sits in, when inside one.
   * Static per slot; used only to drop `.row-playing` in the hidden buffer
   * (MINOR-3). Absent in idle single-buffer mode.
   */
  bufferSlot?: TrackerBufferSlot | undefined;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'selectCell', payload: { row: number; column: number; trackIndex: number; macroNibble?: number | undefined }): void;
  (event: 'startSelection', payload: { row: number; trackIndex: number }): void;
  (event: 'hoverSelection', payload: { row: number; trackIndex: number }): void;
}>();

// Cache isActiveTrack check - only recompute when trackIndex or activeTrack changes
const isActiveTrack = computed(() => props.trackIndex === props.activeTrack);

// The playing row's TEXT brightens during playback (a class toggle only —
// the active-row bar still owns fill/border). Injected as a ref so only the
// two entries whose answer flips per tick re-render; TrackerTrack never does.
const playbackRow = inject(TRACKER_PLAYBACK_ROW, ref(-1));
// TRACKER_PLAYBACK_ROW reaches both ping-pong buffers; a hidden-buffer entry
// must never light up (MINOR-3). `isSlotVisible` has stable identity and
// reads reactive `activeSlot`, so this computed stays reactive with no
// per-tick prop churn through TrackerTrack.
const isSlotVisible = inject(TRACKER_SLOT_VISIBLE, null);
const isPlayingRow = computed(() => {
  if (playbackRow.value !== props.rowIndex) return false;
  if (props.bufferSlot && isSlotVisible && !isSlotVisible(props.bufferSlot)) return false;
  return true;
});

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
  'row-playing': isPlayingRow.value,
  'row-bar': !props.active && !props.selected && rowType.value === 'bar',
  'row-beat': !props.active && !props.selected && rowType.value === 'beat',
  'row-sub': !props.active && !props.selected && rowType.value === 'sub',
  'dual-effects': props.showExtraEffectColumn
}));

// Default cells for empty entries - reused across empty rows (frozen to prevent reactivity overhead)
const DEFAULT_CELLS = Object.freeze({
  note: Object.freeze({ display: '---', className: 'note' }),
  instrument: Object.freeze({ display: '..', className: 'instrument' }),
  volumeHi: Object.freeze({ display: '.', className: 'volume volume-high' }),
  volumeLo: Object.freeze({ display: '.', className: 'volume volume-low' }),
  macroDigits: Object.freeze(['.', '.', '.']),
  macro2Digits: Object.freeze(['.', '.', '.'])
});

// Process cells only when entry exists - optimized to avoid unnecessary string operations
const cells = computed(() => {
  if (!props.entry) return DEFAULT_CELLS;
  return formatEntryCells(props.entry);
});

// Pre-compute active cell states to avoid repeated function calls in template
const activeCells = computed(() => {
  if (!isActiveTrack.value || !props.active) {
    return [false, false, false, false, false, false];
  }
  const col = props.activeColumn;
  return [col === 0, col === 1, col === 2, col === 3, col === 4, col === 5];
});

// Event delegation handler - single click handler for all cells
function handleClick(event: MouseEvent) {
  const target = event.target as HTMLElement;

  // Check for macro digit click first (nested inside effect cell)
  const macroAttr = target.dataset.macro;
  if (macroAttr !== undefined) {
    const macroNibble = parseInt(macroAttr, 10);
    const cellAttr = target.closest('[data-cell]')?.getAttribute('data-cell');
    const column = cellAttr !== undefined && cellAttr !== null ? parseInt(cellAttr, 10) : 4;
    emit('selectCell', { row: props.rowIndex, column, trackIndex: props.trackIndex, macroNibble });
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

.tracker-entry.dual-effects {
  grid-template-columns: 1.6fr 1fr 0.35fr 0.35fr 1.5fr 1.5fr;
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

/*
 * Playing-row text: during playback the actively playing row lifts its cell
 * text so it reads clearly against the pill, and goes bold (Morten,
 * 2026-09-11: "make all text on active rows bold" — confirmed no layout
 * shift, since every `.cell` sits in a fixed `fr` grid track with
 * `overflow: hidden; white-space: nowrap`, so a heavier glyph clips instead
 * of widening its column). The .active-row-bar fill/border is untouched, and
 * nothing behind the glyphs changes. Colour derived from --tracker-* tokens
 * so it stays legible on every theme; `.note` and `.macro-digit` are already
 * bold unconditionally (see below), so this rule's `font-weight` only
 * changes instrument and volume, which are regular weight everywhere else.
 *
 * Note/instrument/volume brighten toward note-text (as shipped). Effect and
 * macro-digit text brightens toward its OWN hue instead (a hue-preserving
 * brighter --tracker-effect-text) — the note-text rule below would otherwise
 * win on specificity and collapse the effect column to white when the
 * editing cursor also sits on the playing row (MINOR-4). The
 * `.effect`/`.macro-digit` rule comes second so it takes that column back at
 * equal specificity; it does not restate `font-weight` because the base
 * `.cell` rule above already applies (and `.macro-digit` is bold regardless).
 */
.tracker-entry.row-playing .cell {
  color: var(--tracker-note-text, #ffffff);
  font-weight: 700;
}

.tracker-entry.row-playing .effect,
.tracker-entry.row-playing .macro-digit {
  color: var(--tracker-effect-text-bright, var(--tracker-effect-text, #8ef5c5));
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

.effect.interpolated-linear {
  background: rgba(77, 242, 197, 0.08);
}

.effect.interpolated-exponential {
  background: rgba(158, 197, 255, 0.1);
}
</style>

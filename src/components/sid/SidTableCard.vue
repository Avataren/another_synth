<template>
  <fieldset class="sid-card sid-table-card" :data-testid="`sid-table-${table}`">
    <legend>{{ label }} table</legend>
    <div class="sid-table-card__head">
      <span :data-testid="`sid-${table}-length`">{{ rows.length }} of {{ SID_MAX_TABLE_ROWS }} rows</span>
      <span v-if="pointer" class="sid-table-card__ptr" :data-testid="`sid-${table}-starts`">
        this instrument starts at <b>{{ hexByte(pointer) }}</b>
      </span>
      <span v-else class="sid-dim" :data-testid="`sid-${table}-starts`">this instrument does not use it</span>
    </div>
    <div ref="scroller" class="sid-table-scroll">
      <table class="sid-table">
        <thead>
          <tr class="sid-dim">
            <th title="Row number, in hex, as the pointers name it">Row</th>
            <th>{{ columns[0] }}</th>
            <th>{{ columns[1] }}</th>
            <th class="sid-table__what">What it does</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="rows.length === 0">
            <td colspan="4" class="sid-dim sid-table__empty">Empty. Add a row, or start a sequence below.</td>
          </tr>
          <tr v-else-if="visibleRows.length === 0">
            <td colspan="4" class="sid-dim sid-table__empty" :data-testid="`sid-${table}-none-mine`">
              This instrument uses none of this table's rows.
            </td>
          </tr>
          <tr
            v-for="index in visibleRows"
            :key="index"
            :data-row="index + 1"
            :class="{
              'sid-table__mine': reached.includes(index + 1),
              'sid-table__now': current === index + 1,
              'sid-table__selected': selected === index + 1,
              'sid-table__free': !reached.includes(index + 1) && !usedBy.has(index + 1),
            }"
            :data-testid="`sid-${table}-row-${index + 1}`"
            @click="selected = index + 1"
          >
            <td class="sid-table__num" :title="rowTitle(index + 1)">
              <span v-if="pointer === index + 1" class="sid-table__start" :data-testid="`sid-${table}-start-marker`">▶</span>{{ hexByte(index + 1) }}
            </td>
            <td v-for="side in SIDES" :key="side">
              <input
                class="sid-hex"
                maxlength="2"
                spellcheck="false"
                :value="hexByte(rows[index]![side])"
                :aria-label="`${label} row ${hexByte(index + 1)} ${side === 'left' ? columns[0] : columns[1]}`"
                :data-testid="`sid-${table}-${index + 1}-${side}`"
                @focus="selected = index + 1"
                @change="emit('set-byte', index, side, $event)"
                @keydown="onKey(index, side, $event)"
              />
            </td>
            <td class="sid-table__what" :data-testid="`sid-${table}-${index + 1}-desc`">
              {{ describeSidTableRow(table, rows[index]!, rows.length, chip) }}
              <span v-if="othersOn(index + 1).length" class="sid-table__shared" :title="`Also reached by instrument ${othersOn(index + 1).map(hexByte).join(', ')}: an edit here changes them too.`">
                shared
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="sid-table-card__tools">
      <q-btn
        flat
        dense
        size="sm"
        icon="add"
        label="Row"
        title="Add a 00 00 row at the end of the table"
        :disable="full"
        :data-testid="`sid-${table}-add`"
        @click="emit('insert', rows.length + 1)"
      />
      <q-btn
        flat
        dense
        size="sm"
        icon="vertical_align_top"
        label="Insert"
        title="Insert a row above the selected one (Insert key). Pointers, jumps and commands keep their rows."
        :disable="full || selected === null"
        :data-testid="`sid-${table}-insert`"
        @click="selected !== null && emit('insert', selected)"
      />
      <q-btn
        flat
        dense
        size="sm"
        icon="delete"
        label="Delete"
        title="Delete the selected row (Ctrl+Delete). Rows below move up, and every pointer, jump and command follows them."
        :disable="selected === null"
        :data-testid="`sid-${table}-delete`"
        @click="deleteSelected"
      />
      <q-btn
        flat
        dense
        size="sm"
        icon="backspace"
        label="Clear"
        title="Set the selected row to 00 00"
        :disable="selected === null"
        :data-testid="`sid-${table}-clear`"
        @click="selected !== null && emit('clear', selected)"
      />
      <q-btn
        flat
        dense
        size="sm"
        icon="play_arrow"
        label="Start here"
        :title="`Point this instrument's ${label.toLowerCase()} table at the selected row`"
        :disable="selected === null || selected === pointer"
        :data-testid="`sid-${table}-point`"
        @click="selected !== null && emit('set-pointer', selected)"
      />
      <select
        class="sid-table-card__template"
        :data-testid="`sid-${table}-template`"
        title="Append a ready-made sequence to the table and point this instrument at it"
        @change="onTemplate"
      >
        <option value="">New sequence…</option>
        <option v-for="t in SID_TABLE_TEMPLATES[table]" :key="t.id" :value="t.id" :title="t.title">{{ t.label }}</option>
      </select>
    </div>
    <p class="sid-dim sid-note">
      <slot name="hint" />
      Keys: ↑/↓ move between rows, Enter goes down, Insert adds a row above, Ctrl+Delete removes one.
    </p>
  </fieldset>
</template>

<script setup lang="ts">
/**
 * One of the song's four shared step tables on the SID instrument page: the
 * rows as hex byte pairs with what each does in words, the rows this
 * instrument reaches, the one its pointer starts at (▶) and the one the
 * page's frame cursor is on, and GoatTracker's row edits (insert, delete,
 * clear, point the instrument here, a starter sequence). It emits; the page
 * turns each into a doc op with an undo step.
 */
import { computed, nextTick, ref } from 'vue';
import { SID_MAX_TABLE_ROWS, type SidChipModel, type SidTableName, type SidTableRow } from 'src/audio/tracker/sid-doc';
import { hexByte } from 'src/audio/tracker/sid-instrument-edit';
import { SID_TABLE_TEMPLATES, describeSidTableRow } from 'src/audio/tracker/sid-table-rows';

interface Props {
  table: SidTableName;
  label: string;
  rows: readonly SidTableRow[];
  chip: SidChipModel;
  /** This instrument's 1-based start row; 0 = none. */
  pointer: number;
  /** Rows this instrument reaches from its pointer. */
  reached: readonly number[];
  /** The row the frame cursor's frame read; 0 = none. */
  current: number;
  /** Per row, the instruments other than this one that reach it. */
  usedBy: ReadonlyMap<number, readonly number[]>;
  instrument: number;
  /** Show only the rows this instrument reaches (`reached`), hiding the rest of the song's table. */
  onlyMine?: boolean;
}
const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'set-byte', index: number, side: 'left' | 'right', domEvent: Event): void;
  (event: 'insert', at: number): void;
  (event: 'delete', at: number): void;
  (event: 'clear', at: number): void;
  (event: 'set-pointer', row: number): void;
  (event: 'template', id: string): void;
}>();

const SIDES = ['left', 'right'] as const;
const COLUMNS: Record<SidTableName, readonly [string, string]> = {
  wave: ['Wave', 'Note'],
  pulse: ['Cmd', 'Value'],
  filter: ['Cmd', 'Value'],
  speed: ['Hi', 'Lo'],
};
const columns = computed(() => COLUMNS[props.table]);
const full = computed(() => props.rows.length >= SID_MAX_TABLE_ROWS);

/** The selected row (1-based), the one the row buttons act on. */
const selected = ref<number | null>(null);
const scroller = ref<HTMLElement | null>(null);

/** The 0-based indexes of the rows shown, in table order. */
const visibleRows = computed<number[]>(() =>
  props.onlyMine ? [...props.reached].sort((a, b) => a - b).map((r) => r - 1).filter((i) => i < props.rows.length) : props.rows.map((_, i) => i),
);

/** The shown row after (`step` 1) or before (-1) 1-based row `row`, or null at the end. */
function neighbour(row: number, step: 1 | -1): number | null {
  const shown = visibleRows.value;
  const at = shown.indexOf(row - 1);
  const next = shown[at + step];
  return at === -1 || next === undefined ? null : next + 1;
}

const othersOn = (row: number): number[] => (props.usedBy.get(row) ?? []).filter((n) => n !== props.instrument);

function rowTitle(row: number): string {
  const parts = [`Row ${hexByte(row)} (${row} in decimal)`];
  if (props.pointer === row) parts.push('this instrument starts here');
  if (props.current === row) parts.push('the frame cursor is on this row');
  const others = othersOn(row);
  if (others.length) parts.push(`also used by instrument ${others.map(hexByte).join(', ')}`);
  else if (!props.reached.includes(row)) parts.push('no instrument starts in reach of this row');
  return parts.join(' · ');
}

function focusCell(row: number, side: 'left' | 'right'): void {
  void nextTick(() => {
    const input = scroller.value?.querySelector<HTMLInputElement>(`[data-testid="sid-${props.table}-${row}-${side}"]`);
    input?.focus();
    input?.select();
  });
}

function onKey(index: number, side: 'left' | 'right', event: KeyboardEvent): void {
  const row = index + 1;
  if (event.key === 'ArrowDown' || event.key === 'Enter') {
    event.preventDefault();
    (event.target as HTMLInputElement).blur();
    const next = neighbour(row, 1);
    if (next !== null) focusCell(next, side);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    (event.target as HTMLInputElement).blur();
    const previous = neighbour(row, -1);
    if (previous !== null) focusCell(previous, side);
  } else if (event.key === 'Insert') {
    event.preventDefault();
    if (!full.value) emit('insert', row);
    focusCell(row, side);
  } else if (event.key === 'Delete' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    emit('delete', row);
    if (props.rows.length > 1) focusCell(Math.min(row, props.rows.length - 1), side);
  }
}

function deleteSelected(): void {
  if (selected.value === null) return;
  emit('delete', selected.value);
  if (selected.value > props.rows.length - 1) selected.value = props.rows.length > 1 ? props.rows.length - 1 : null;
}

function onTemplate(event: Event): void {
  const select = event.target as HTMLSelectElement;
  if (select.value) emit('template', select.value);
  select.value = '';
}

/** Selects row `row` and scrolls it into view (the pointer fields' "show" button). */
function reveal(row: number): void {
  if (row < 1 || row > props.rows.length) return;
  selected.value = row;
  void nextTick(() => scroller.value?.querySelector(`[data-row="${row}"]`)?.scrollIntoView?.({ block: 'nearest' }));
}
defineExpose({ reveal });
</script>

<style scoped>
.sid-table-card__head {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  font-size: 0.85em;
}
.sid-table-card__ptr b {
  font-family: monospace;
  color: var(--tracker-accent-primary, #4df2c5);
}
.sid-table-card__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 4px;
}
.sid-table-card__template {
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  font-size: 0.85em;
}
.sid-table-scroll {
  max-height: 360px;
  overflow-y: auto;
}
.sid-table {
  border-collapse: collapse;
  font-family: monospace;
  width: 100%;
}
.sid-table th {
  text-align: left;
  font-weight: normal;
  font-size: 0.8em;
  padding: 0 4px;
}
.sid-table td {
  padding: 1px 4px;
}
.sid-table tbody tr {
  cursor: pointer;
}
.sid-table__num {
  white-space: nowrap;
  opacity: 0.8;
}
.sid-table__start {
  color: var(--tracker-accent-primary, #4df2c5);
  margin-right: 2px;
}
.sid-table__what {
  font-family: system-ui, sans-serif;
  font-size: 0.8em;
  opacity: 0.85;
}
.sid-table__free .sid-table__what {
  opacity: 0.5;
}
.sid-table__shared {
  margin-left: 4px;
  padding: 0 4px;
  border: 1px solid rgba(240, 178, 94, 0.6);
  border-radius: 3px;
  color: #f0b25e;
  font-size: 0.9em;
}
.sid-table__mine {
  background: rgba(77, 242, 197, 0.12);
}
.sid-table__now {
  box-shadow: inset 3px 0 0 var(--tracker-accent-primary, #4df2c5);
  background: rgba(77, 242, 197, 0.26);
}
.sid-table__selected td {
  outline: 1px dashed rgba(255, 255, 255, 0.35);
  outline-offset: -1px;
}
.sid-table__empty {
  padding: 8px 4px;
  font-family: system-ui, sans-serif;
}
.sid-hex {
  width: 2.8em;
  text-align: center;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 3px;
  padding: 2px 4px;
  font-family: monospace;
}
.sid-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  padding: 8px 12px 12px;
  display: grid;
  gap: 8px;
}
.sid-dim {
  opacity: 0.65;
}
.sid-note {
  margin: 0;
  font-size: 0.85em;
}
</style>

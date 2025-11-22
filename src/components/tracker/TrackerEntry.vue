<template>
  <div
    class="tracker-entry"
    :class="{ active, filled: !!entry, focused: isActiveTrack && active }"
    :style="{ '--entry-accent': accentColor || 'var(--tracker-accent)' }"
    role="button"
    tabindex="-1"
    @click="onSelectRow"
  >
    <span
      v-for="(cell, idx) in cells"
      :key="idx"
      class="cell"
      :class="[cell.className, { 'cell-active': isActiveCell(idx) }]"
      @click.stop="onSelectCell(idx)"
    >
      {{ cell.display }}
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
  accentColor?: string | undefined;
  trackIndex: number;
  activeTrack: number;
  activeColumn: number;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'selectCell', payload: { row: number; column: number; trackIndex: number }): void;
}>();

const isActiveTrack = computed(() => props.trackIndex === props.activeTrack);

const cells = computed(() => {
  return [
    { display: props.entry?.note ?? '---', className: 'note' },
    { display: props.entry?.instrument ?? '..', className: 'instrument' },
    { display: props.entry?.volume ?? '..', className: 'volume' },
    { display: props.entry?.effect ?? '---', className: 'effect' }
  ];
});

function onSelectRow() {
  emit('selectCell', { row: props.rowIndex, column: 0, trackIndex: props.trackIndex });
}

function onSelectCell(column: number) {
  emit('selectCell', { row: props.rowIndex, column, trackIndex: props.trackIndex });
}

function isActiveCell(column: number) {
  return isActiveTrack.value && props.active && props.activeColumn === column;
}
</script>

<style scoped>
.tracker-entry {
  --entry-accent: var(--tracker-accent);
  height: var(--tracker-row-height);
  width: 100%;
  display: grid;
  grid-template-columns: 1.6fr 1fr 1fr 1.4fr;
  align-items: center;
  padding: 6px 10px;
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  background: rgba(13, 18, 29, 0.85);
  color: #d8e7ff;
  font-family: 'IBM Plex Mono', 'JetBrains Mono', monospace;
  font-size: 12px;
  letter-spacing: 0.03em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color 120ms ease, background-color 120ms ease, transform 80ms ease;
}

.tracker-entry:hover {
  border-color: rgba(255, 255, 255, 0.12);
}

.tracker-entry.filled {
  background: linear-gradient(90deg, rgba(21, 31, 48, 0.95), rgba(17, 24, 38, 0.95));
}

.tracker-entry.active {
  border-color: var(--entry-accent);
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.05), 0 6px 14px rgba(0, 0, 0, 0.35);
  background: linear-gradient(
    90deg,
    rgba(45, 191, 255, 0.12),
    rgba(77, 255, 205, 0.16)
  );
  transform: translateY(-1px);
}

.tracker-entry.focused {
  border-color: var(--entry-accent);
}

.tracker-entry:active {
  transform: translateY(0);
}

.cell {
  text-align: left;
  white-space: nowrap;
}

.cell-active {
  color: #0c1624;
  font-weight: 800;
  background: linear-gradient(90deg, rgba(77, 242, 197, 0.9), rgba(88, 176, 255, 0.9));
  border-radius: 6px;
  padding: 2px 6px;
}

.note {
  color: #ffffff;
  font-weight: 700;
}

.instrument {
  color: rgba(255, 255, 255, 0.82);
}

.volume {
  color: #85b7ff;
}

.effect {
  color: #8ef5c5;
}
</style>

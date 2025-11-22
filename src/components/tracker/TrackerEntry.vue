<template>
  <button
    type="button"
    class="tracker-entry"
    :class="{ active, filled: !!entry }"
    :style="{ '--entry-accent': accentColor || 'var(--tracker-accent)' }"
    @click="onSelectRow"
  >
    <span class="cell note">{{ entry?.note ?? '---' }}</span>
    <span class="cell instrument">{{ entry?.instrument ?? '..' }}</span>
    <span class="cell volume">{{ entry?.volume ?? '..' }}</span>
    <span class="cell effect">{{ entry?.effect ?? '---' }}</span>
  </button>
</template>

<script setup lang="ts">
import type { TrackerEntryData } from './tracker-types';

interface Props {
  entry?: TrackerEntryData | undefined;
  rowIndex: number;
  active: boolean;
  accentColor?: string | undefined;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: 'selectRow', row: number): void;
}>();

function onSelectRow() {
  emit('selectRow', props.rowIndex);
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

.tracker-entry:active {
  transform: translateY(0);
}

.cell {
  text-align: left;
  white-space: nowrap;
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

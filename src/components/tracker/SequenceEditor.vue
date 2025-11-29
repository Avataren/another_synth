<template>
  <div class="sequence-editor">
    <div class="sequence-list-container">
      <div
        v-for="(patternId, index) in sequence"
        :key="`${patternId}-${index}`"
        :ref="el => { if (index === currentSequenceIndex || patternId === currentPatternId) activeSequenceItem = el as HTMLElement | null }"
        class="sequence-item"
        :class="{
          'is-selected': patternId === currentPatternId,
          'is-playing': index === currentSequenceIndex && isPlaying
        }"
        @click="$emit('select-pattern', patternId)"
        @dblclick.stop="startRename(patternId)"
      >
        <div class="pattern-name-wrapper">
          <div class="sequence-number">{{ index + 1 }}.</div>
          <div class="active-indicator" v-if="patternId === currentPatternId">▶</div>
          <div class="pattern-name">
            <input
              v-if="editingPatternId === patternId"
              ref="renameInput"
              v-model="editingName"
              class="rename-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              @keydown.enter.prevent="commitRename()"
              @keydown.esc.prevent="cancelRename"
              @blur="commitRename()"
            />
            <span v-else>
              {{ getPatternName(patternId) }}
            </span>
          </div>
        </div>
        <div class="item-actions">
          <button @click.stop="$emit('move-sequence-item', index, index - 1)" :disabled="index === 0">&uarr;</button>
          <button @click.stop="$emit('move-sequence-item', index, index + 1)" :disabled="index === sequence.length - 1">&darr;</button>
          <button @click.stop="$emit('remove-pattern-from-sequence', index)">&times;</button>
        </div>
      </div>
    </div>
    <div class="sequence-controls">
      <q-select
        v-model="selectedPatternId"
        :options="patternOptions"
        label="Add Pattern"
        dense
        dark
        filled
        options-dark
        emit-value
        map-options
        dropdown-icon="expand_more"
        behavior="menu"
        class="pattern-select"
        @update:model-value="onAddPatternToSequence"
        @popup-hide="requestRefocus"
        @blur="requestRefocus"
      />
      <button type="button" @click="$emit('create-pattern')">New Pattern</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { TrackerPattern } from 'src/stores/tracker-store';

const props = defineProps<{
  sequence: string[];
  patterns: TrackerPattern[];
  currentPatternId: string | null;
  currentSequenceIndex?: number;
  isPlaying?: boolean;
}>();

const emit = defineEmits<{
  (e: 'select-pattern', patternId: string): void;
  (e: 'add-pattern-to-sequence', patternId: string): void;
  (e: 'remove-pattern-from-sequence', index: number): void;
  (e: 'create-pattern'): void;
  (e: 'move-sequence-item', fromIndex: number, toIndex: number): void;
  (e: 'rename-pattern', patternId: string, name: string): void;
  (e: 'request-refocus'): void;
}>();

const selectedPatternId = ref<string | null>(null);
const editingPatternId = ref<string | null>(null);
const editingName = ref('');
const renameInput = ref<HTMLInputElement | null>(null);
const activeSequenceItem = ref<HTMLElement | null>(null);

const patternOptions = computed(() =>
  props.patterns.map((pattern) => ({
    label: pattern.name,
    value: pattern.id
  }))
);

const requestRefocus = () => emit('request-refocus');

// Auto-scroll the active pattern into view when sequence position changes
watch(() => props.currentSequenceIndex, () => {
  if (props.isPlaying && activeSequenceItem.value) {
    nextTick(() => {
      activeSequenceItem.value?.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest'
      });
    });
  }
});

const getPatternName = (patternId: string) => {
  return props.patterns.find(p => p.id === patternId)?.name ?? 'Unknown Pattern';
};

const startRename = (patternId: string) => {
  editingPatternId.value = patternId;
  editingName.value = getPatternName(patternId);
  nextTick(() => renameInput.value?.focus());
};

const cancelRename = () => {
  editingPatternId.value = null;
  editingName.value = '';
  requestRefocus();
};

const commitRename = () => {
  if (!editingPatternId.value) return;
  const nextName = editingName.value.trim();
  const patternId = editingPatternId.value;
  const currentName = getPatternName(patternId);

  if (nextName && nextName !== currentName) {
    emit('rename-pattern', patternId, nextName);
  }

  cancelRename();
};

const onAddPatternToSequence = (patternId: string | null) => {
  if (patternId) {
    emit('add-pattern-to-sequence', patternId);
    selectedPatternId.value = null;
  }
  requestRefocus();
};
</script>

<style scoped>
.sequence-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 14px;
  padding: 10px 12px;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.28);
  contain: layout style paint;
}
.sequence-list-container {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 200px;
  overflow-y: auto;
}

.sequence-list-container::-webkit-scrollbar {
  width: 6px;
}

.sequence-list-container::-webkit-scrollbar-thumb {
  background: var(--button-background, rgba(255, 255, 255, 0.12));
  border-radius: 999px;
}

.sequence-list-container::-webkit-scrollbar-thumb:hover {
  background: var(--button-background-hover, rgba(255, 255, 255, 0.18));
}

.sequence-list-container::-webkit-scrollbar-track {
  background: transparent;
}
.sequence-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid transparent;
  cursor: pointer;
  contain: layout style paint;
  transition: all 0.15s ease;
}
.sequence-item:hover {
  background: rgba(0, 0, 0, 0.35);
}

.sequence-item.is-selected {
  background: var(--tracker-selected-bg, rgba(77, 242, 197, 0.12));
  border-color: var(--tracker-accent-primary, #4df2c5);
}

.sequence-item.is-playing {
  background: rgba(88, 176, 255, 0.12);
  border-color: var(--tracker-accent-secondary, rgb(88, 176, 255));
}

.sequence-item.is-selected.is-playing {
  /* Both selected and playing - combine the styles */
  background: linear-gradient(135deg, rgba(77, 242, 197, 0.12) 0%, rgba(88, 176, 255, 0.12) 100%);
  border-color: var(--tracker-accent-primary, #4df2c5);
  box-shadow: 0 0 0 1px var(--tracker-accent-secondary, rgb(88, 176, 255)) inset;
}

.pattern-name-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

.sequence-number {
  color: var(--text-secondary, rgba(232, 243, 255, 0.6));
  font-size: 11px;
  font-weight: 600;
  flex-shrink: 0;
  min-width: 20px;
}

.active-indicator {
  color: var(--tracker-accent-primary, #4df2c5);
  font-size: 12px;
  line-height: 1;
  flex-shrink: 0;
}

.pattern-name {
  font-weight: bold;
  flex: 1;
  min-width: 0;
}

.rename-input {
  width: 100%;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 6px;
  padding: 4px 6px;
  color: #e8f3ff;
  font-weight: 700;
}
.rename-input:focus {
  outline: 1px solid var(--tracker-accent-primary, rgba(77, 242, 197, 0.6));
}
.item-actions button {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
}
.sequence-controls {
  display: flex;
  gap: 8px;
}

.sequence-controls .pattern-select {
  flex: 1;
}

.sequence-controls :deep(.q-field__control) {
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  min-height: 44px;
  color: #e8f3ff;
}

.sequence-controls :deep(.q-field__control:before),
.sequence-controls :deep(.q-field__control:after),
.sequence-controls :deep(.q-field--focused .q-field__control:before),
.sequence-controls :deep(.q-field--focused .q-field__control:after) {
  opacity: 0 !important; /* Remove default underline/white focus line */
  border: none;
}

.sequence-controls :deep(.q-field__native) {
  color: #e8f3ff;
  font-weight: 700;
}

.sequence-controls :deep(.q-item__label) {
  color: #e8f3ff;
}

.sequence-controls :deep(.q-menu) {
  background: #0f1624;
}

.sequence-controls button {
  flex-grow: 1;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.04);
  color: #e8f3ff;
  font-weight: 700;
}
</style>

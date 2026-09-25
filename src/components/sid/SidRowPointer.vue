<template>
  <div class="sid-ptr" :title="title ?? ''">
    <span class="sid-ptr__label">{{ label }}</span>
    <input
      class="sid-ptr__input"
      maxlength="2"
      spellcheck="false"
      :value="hexByte(modelValue)"
      :aria-label="`${label}, a row number in hex (00 = none)`"
      :data-testid="testid"
      @change="onChange"
      @keydown.up.prevent="step(1)"
      @keydown.down.prevent="step(-1)"
    />
    <span class="sid-ptr__state" :data-testid="`${testid}-state`">
      <template v-if="modelValue === 0">{{ noneText }}</template>
      <template v-else>row {{ hexByte(modelValue) }} of {{ hexByte(tableLength) }}</template>
    </span>
    <button v-if="modelValue !== 0" type="button" class="sid-ptr__btn" :data-testid="`${testid}-show`" title="Select the row in its table" @click="emit('reveal', modelValue)">
      show
    </button>
    <button v-if="modelValue !== 0" type="button" class="sid-ptr__btn" :data-testid="`${testid}-none`" title="Stop using the table (pointer 00)" @click="emit('update:modelValue', 0)">
      none
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * An instrument's pointer into one of the shared tables, spelled as the
 * tables number their rows: two hex digits, `00` for none, `01` the first
 * row. A typed value past the table is refused and the kept one shown again;
 * ↑/↓ step through the table's rows.
 */
import { hexByte } from 'src/audio/tracker/sid-instrument-edit';

interface Props {
  modelValue: number;
  tableLength: number;
  label: string;
  testid: string;
  /** What pointer 00 means for this table. */
  noneText: string;
  title?: string;
}
const props = withDefaults(defineProps<Props>(), { title: '' });
const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void;
  (event: 'reveal', row: number): void;
}>();

function onChange(event: Event): void {
  const input = event.target as HTMLInputElement;
  const text = input.value.trim();
  const value = /^[0-9a-fA-F]{1,2}$/.test(text) ? parseInt(text, 16) : NaN;
  if (Number.isInteger(value) && value <= props.tableLength) emit('update:modelValue', value);
  input.value = hexByte(Number.isInteger(value) && value <= props.tableLength ? value : props.modelValue);
}

function step(delta: number): void {
  const next = Math.max(0, Math.min(props.tableLength, props.modelValue + delta));
  if (next !== props.modelValue) emit('update:modelValue', next);
}
</script>

<style scoped>
.sid-ptr {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.sid-ptr__label {
  min-width: 100px;
  opacity: 0.65;
}
.sid-ptr__input {
  width: 2.8em;
  text-align: center;
  background: rgba(0, 0, 0, 0.3);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
  padding: 2px 4px;
  font-family: monospace;
}
.sid-ptr__state {
  opacity: 0.6;
  font-size: 0.85em;
}
.sid-ptr__btn {
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  font-size: 0.8em;
  cursor: pointer;
}
</style>

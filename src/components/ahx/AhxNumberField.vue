<template>
  <label class="ahx-field" :class="{ 'ahx-field--compact': compact }">
    <span v-if="label" class="ahx-field__label">{{ label }}</span>
    <input
      class="ahx-field__input"
      type="number"
      inputmode="numeric"
      step="1"
      :min="min ?? 0"
      :max="max"
      :value="modelValue"
      :disabled="disabled === true"
      :title="title ?? ''"
      :data-testid="testid ?? ''"
      @input="onInput"
      @blur="onBlur"
    />
    <span v-if="suffix" class="ahx-field__suffix">{{ suffix }}</span>
  </label>
</template>

<script setup lang="ts">
interface Props {
  modelValue: number;
  min?: number;
  max: number;
  label?: string;
  suffix?: string;
  title?: string;
  testid?: string;
  disabled?: boolean;
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  label: '',
  suffix: '',
});

const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void;
}>();

/** Every keystroke that makes a whole number is an edit, clamped into range. */
function onInput(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.value.trim() === '') return;
  const value = Number(input.value);
  if (!Number.isFinite(value)) return;
  emit('update:modelValue', Math.min(props.max, Math.max(props.min ?? 0, Math.round(value))));
}

/** Leaving the field shows the value that was kept (an empty or out-of-range entry is put right). */
function onBlur(event: Event): void {
  (event.target as HTMLInputElement).value = String(props.modelValue);
}
</script>

<style scoped>
.ahx-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ahx-field__label {
  min-width: 110px;
  opacity: 0.65;
}

.ahx-field--compact .ahx-field__label {
  min-width: 0;
}

.ahx-field__input {
  width: 64px;
  padding: 2px 4px;
  color: inherit;
  font: inherit;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 3px;
}

.ahx-field--compact .ahx-field__input {
  width: 52px;
}

.ahx-field__input:focus {
  outline: 1px solid var(--tracker-accent-secondary, #5ec2e8);
}

.ahx-field__suffix {
  opacity: 0.55;
  font-size: 0.8rem;
}
</style>

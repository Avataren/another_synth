<template>
  <div class="ahx-segmented" role="radiogroup" v-bind="label ? { 'aria-label': label } : {}">
    <span v-if="label" class="ahx-segmented__label">{{ label }}</span>
    <div class="ahx-segmented__options">
      <label
        v-for="option in options"
        :key="option.value"
        class="ahx-segmented__option"
        :class="{ 'ahx-segmented__option--on': option.value === modelValue }"
        :title="option.title ?? ''"
      >
        <input
          type="radio"
          class="ahx-segmented__input"
          :name="groupName"
          :value="option.value"
          :checked="option.value === modelValue"
          :disabled="disabled === true"
          :data-testid="testid ? `${testid}-${option.value}` : ''"
          @change="emit('update:modelValue', option.value)"
        />
        <span class="ahx-segmented__text">{{ option.label }}</span>
        <span v-if="option.sub" class="ahx-segmented__sub">{{ option.sub }}</span>
      </label>
    </div>
  </div>
</template>

<script lang="ts">
export interface AhxSegmentedOption {
  value: number;
  label: string;
  /** A second, smaller line (e.g. the sample count). */
  sub?: string;
  title?: string;
}

let nextGroup = 0;
</script>

<script setup lang="ts">
/**
 * A segmented picker as a native radio group (editor plan E3): arrow keys move
 * between options, Tab enters the group once, and a screen reader hears a
 * radio group. Deliberately not `q-btn-toggle` (the page is tested with only
 * QPage / QIcon / QBtn stubbed).
 */
interface Props {
  modelValue: number;
  options: ReadonlyArray<AhxSegmentedOption>;
  label?: string;
  testid?: string;
  disabled?: boolean;
}

defineProps<Props>();
const emit = defineEmits<{
  (event: 'update:modelValue', value: number): void;
}>();

const groupName = `ahx-seg-${nextGroup++}`;
</script>

<style scoped>
.ahx-segmented {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}

.ahx-segmented__label {
  min-width: 110px;
  opacity: 0.65;
}

.ahx-segmented__options {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ahx-segmented__option {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  min-width: 44px;
  min-height: 36px;
  padding: 3px 8px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  user-select: none;
}

.ahx-segmented__option--on {
  background: var(--tracker-active-bg, #14283d);
  border-color: var(--tracker-accent-secondary, #5ec2e8);
}

/* The radio itself is visually hidden but stays focusable and in the accessibility tree. */
.ahx-segmented__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.ahx-segmented__option:focus-within {
  outline: 2px solid var(--tracker-accent-primary, #f0b25e);
}

.ahx-segmented__sub {
  font-size: 0.7rem;
  opacity: 0.6;
}
</style>

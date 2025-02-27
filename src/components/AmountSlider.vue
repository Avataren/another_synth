<template>
  <div class="amount-slider-container row items-center q-gutter-x-sm">
    <q-slider
      :model-value="localValue"
      :min="min"
      :max="max"
      :step="step"
      :label="true"
      label-always
      dark
      class="col"
      @update:model-value="(val: number | null) => handleSliderChange(val)"
    />
    <q-input
      :model-value="localValue"
      type="number"
      dense
      dark
      filled
      :min="min"
      :max="max"
      :step="step"
      style="width: 60px"
      @update:model-value="
        (val: string | number | null) => handleInputChange(val)
      "
    />
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

interface Props {
  modelValue: number;
  min?: number;
  max?: number;
  step?: number;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 100,
  step: 1,
});

const emit = defineEmits<{
  'update:modelValue': [value: number];
}>();

const localValue = ref(props.modelValue);

// Watch for external changes
watch(
  () => props.modelValue,
  (newVal) => {
    localValue.value = newVal;
  },
);

// Handle slider changes
const handleSliderChange = (value: number | null) => {
  // Handle null by using current value
  const numValue = value ?? localValue.value;
  const boundedValue = Math.min(Math.max(numValue, props.min), props.max);
  localValue.value = boundedValue;
  emit('update:modelValue', boundedValue);
};

// Handle input changes
const handleInputChange = (value: string | number | null) => {
  // Convert string to number and handle null/invalid cases
  let numValue: number;

  if (value === null || value === '') {
    numValue = props.min;
  } else if (typeof value === 'string') {
    const parsed = parseFloat(value);
    numValue = isNaN(parsed) ? props.min : parsed;
  } else {
    numValue = value;
  }

  const boundedValue = Math.min(Math.max(numValue, props.min), props.max);
  localValue.value = boundedValue;
  emit('update:modelValue', boundedValue);
};
</script>

<style scoped>
.amount-slider-container :deep(.q-slider__track) {
  background: rgba(255, 255, 255, 0.28);
}

.amount-slider-container :deep(.q-slider__thumb) {
  background: white;
}
</style>

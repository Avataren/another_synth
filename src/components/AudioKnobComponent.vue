<!-- AudioKnobComponent.vue -->
<template>
  <div class="knob-wrapper">
    <div class="knob-container">
      <q-knob
        :angle="180"
        :model-value="modelValue"
        @update:model-value="$emit('update:modelValue', $event)"
        :min="min"
        :max="max"
        :step="step"
        size="70px"
        show-value
        :thickness="0.22"
        :color="color"
        :track-color="trackColor"
        class="q-mb-sm"
        :decimals="decimals"
        :display-value="!isEditing"
      >
        <div
          @click.stop.prevent="startEditing"
          @mousedown.stop.prevent="() => {}"
          class="value-display"
        >
          <template v-if="!isEditing">
            {{ formatValue(modelValue) }}
          </template>
          <q-input
            v-else
            v-model.number="editValue"
            dense
            type="number"
            :min="min"
            :max="max"
            :step="step"
            @blur="finishEditing"
            @keyup.enter="finishEditing"
            class="edit-input"
            ref="inputRef"
            input-class="text-center"
            :rules="[validateValue]"
            hide-bottom-space
          >
            <template v-slot:append v-if="unit">
              <q-label class="text-grey-7">{{ unit }}</q-label>
            </template>
          </q-input>
        </div>
      </q-knob>
    </div>
    <div class="knob-label">{{ label }}</div>
    <div v-if="unit" class="knob-unit">{{ unit }}</div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { QInput } from 'quasar';

interface Props {
  modelValue: number;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  decimals?: number;
  unit?: string;
  color?: string;
  trackColor?: string;
}

const props = withDefaults(defineProps<Props>(), {
  min: 0,
  max: 1,
  step: 0.01,
  decimals: 2,
  unit: '',
  color: 'orange',
  trackColor: 'orange-3',
});

const emit = defineEmits(['update:modelValue']);

const isEditing = ref(false);
const editValue = ref(props.modelValue);
const inputRef = ref<QInput | null>(null);

const formatValue = (value: number) => {
  return `${value.toFixed(props.decimals)}${props.unit}`;
};

const validateValue = (val: number) => {
  const minValid = props.min === undefined || val >= props.min;
  const maxValid = props.max === undefined || val <= props.max;

  if (!minValid || !maxValid) {
    return `Value must be between ${props.min ?? '-∞'} and ${props.max ?? '∞'}`;
  }

  return true;
};

const startEditing = () => {
  editValue.value = props.modelValue;
  isEditing.value = true;
  nextTick(() => {
    inputRef.value?.focus();
  });
};

const finishEditing = () => {
  isEditing.value = false;
  const newValue = Number(editValue.value);

  if (!isNaN(newValue) && validateValue(newValue) === true) {
    emit('update:modelValue', newValue);
  }
};
</script>

<style scoped>
.knob-wrapper {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.5rem;
}

.knob-container {
  position: relative;
}

.value-display {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
  min-width: 40px;
  text-align: center;
  z-index: 1;
}

.edit-input {
  width: 65px;
}

.knob-label {
  margin-top: 0.5rem;
  font-size: 0.9rem;
  font-weight: 500;
  color: rgba(192, 192, 192, 0.7);
}

.knob-unit {
  font-size: 0.8rem;
  color: rgba(192, 192, 192, 0.5);
  margin-top: 0.25rem;
}
</style>
